import { and, eq, lte, sql } from "drizzle-orm";
import {
  db,
  rentalsTable,
  rigsTable,
  usersTable,
  walletTransactionsTable,
} from "@workspace/db";
import { round6, toNum, toUsdString } from "./money";

/**
 * Settle any active rentals whose `endsAt` has passed:
 *   - mark the rental `completed` and stamp `settledAt`
 *   - credit the rig owner the full `ownerEarningsUsd`
 *   - flip the rig back to `available` (only if it isn't already part of
 *     another active rental — by uniqueness of rented status this is safe).
 *
 * Without a real Stratum proxy we cannot yet measure delivery shortfalls,
 * so the owner gets the full pre-agreed payout. When task-2 lands the
 * settlement function will scale `ownerEarningsUsd` by `deliveredHashrateAvg
 * / hashrate`. The skim that would otherwise have been refunded to the renter
 * will be added there.
 */
export async function settleExpiredRentals(): Promise<number> {
  const now = new Date();

  const expired = await db
    .select({ id: rentalsTable.id })
    .from(rentalsTable)
    .where(
      and(
        eq(rentalsTable.status, "active"),
        lte(rentalsTable.endsAt, now),
      ),
    );

  if (expired.length === 0) return 0;

  let settled = 0;

  for (const { id } of expired) {
    const ok = await db.transaction(async (tx) => {
      // Re-check inside the transaction with row lock semantics via
      // a conditional update — only the first concurrent caller wins.
      const [claimed] = await tx
        .update(rentalsTable)
        .set({ status: "completed", settledAt: now })
        .where(
          and(
            eq(rentalsTable.id, id),
            eq(rentalsTable.status, "active"),
            lte(rentalsTable.endsAt, now),
          ),
        )
        .returning();
      if (!claimed) return false;

      const ownerPayout = toNum(claimed.ownerEarningsUsd);
      if (ownerPayout > 0) {
        const [credited] = await tx
          .update(usersTable)
          .set({
            balanceUsd: sql`${usersTable.balanceUsd} + ${toUsdString(ownerPayout)}`,
            totalEarnedUsd: sql`${usersTable.totalEarnedUsd} + ${toUsdString(ownerPayout)}`,
          })
          .where(eq(usersTable.id, claimed.ownerId))
          .returning({ balanceUsd: usersTable.balanceUsd });

        if (credited) {
          await tx.insert(walletTransactionsTable).values({
            userId: claimed.ownerId,
            type: "rental_payout",
            amountUsd: toUsdString(ownerPayout),
            balanceAfterUsd: toUsdString(round6(toNum(credited.balanceUsd))),
            memo: `Payout for completed rental #${claimed.id}`,
            relatedRentalId: claimed.id,
          });
        }
      }

      // Mark the rig available again — but only if no other active rental
      // exists on it (defensive: the schema currently allows only one).
      await tx
        .update(rigsTable)
        .set({ status: "available" })
        .where(
          and(
            eq(rigsTable.id, claimed.rigId),
            eq(rigsTable.status, "rented"),
          ),
        );

      return true;
    });

    if (ok) settled++;
  }

  return settled;
}
