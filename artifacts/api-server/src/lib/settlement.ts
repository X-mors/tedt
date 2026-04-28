import { and, eq, lte, sql } from "drizzle-orm";
import {
  db,
  rentalsTable,
  rigsTable,
  usersTable,
  walletTransactionsTable,
} from "@workspace/db";
import { round6, toNum, toUsdString } from "./money";
import { proxyState } from "./stratum/state";

/**
 * Settle any active rentals whose `endsAt` has passed.
 *
 * Delivery-ratio payout (Task #2):
 *   delivery_ratio = CLIP(deliveredHashrateAvg / hashrate, 0, 1.05)
 *   ownerPayout    = ownerEarningsUsd × delivery_ratio
 *   renterRefund   = renterTotalUsd   × (1 − delivery_ratio)
 *
 * If deliveredHashrateAvg IS NULL (proxy not connected, or no shares arrived)
 * we assume full delivery so the owner is not penalised for infrastructure
 * issues outside their control.
 */
export async function settleExpiredRentals(): Promise<number> {
  const now = new Date();

  const expired = await db
    .select({ id: rentalsTable.id, rigId: rentalsTable.rigId })
    .from(rentalsTable)
    .where(
      and(
        eq(rentalsTable.status, "active"),
        lte(rentalsTable.endsAt, now),
      ),
    );

  if (expired.length === 0) return 0;

  let settled = 0;

  for (const { id, rigId } of expired) {
    const ok = await db.transaction(async (tx) => {
      // Re-check inside the transaction — only the first concurrent caller wins.
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

      const advertisedHashrate = toNum(claimed.hashrate);
      const deliveredHashrate = toNum(claimed.deliveredHashrateAvg);

      const deliveryRatio =
        deliveredHashrate > 0 && advertisedHashrate > 0
          ? Math.min(1.05, deliveredHashrate / advertisedHashrate)
          : 1.0;

      const ownerPayout = round6(toNum(claimed.ownerEarningsUsd) * deliveryRatio);
      const renterRefund = round6(toNum(claimed.renterTotalUsd) * (1 - deliveryRatio));

      if (ownerPayout > 0) {
        const payoutStr = toUsdString(ownerPayout);
        const [credited] = await tx
          .update(usersTable)
          .set({
            balanceUsd: sql`${usersTable.balanceUsd} + ${payoutStr}`,
            totalEarnedUsd: sql`${usersTable.totalEarnedUsd} + ${payoutStr}`,
          })
          .where(eq(usersTable.id, claimed.ownerId))
          .returning({ balanceUsd: usersTable.balanceUsd });

        if (credited) {
          await tx.insert(walletTransactionsTable).values({
            userId: claimed.ownerId,
            type: "rental_payout",
            amountUsd: payoutStr,
            balanceAfterUsd: toUsdString(round6(toNum(credited.balanceUsd))),
            memo: `Payout for rental #${claimed.id} (${Math.round(deliveryRatio * 100)}% delivery)`,
            relatedRentalId: claimed.id,
          });
        }
      }

      if (renterRefund > 0) {
        const refundStr = toUsdString(renterRefund);
        const [credited] = await tx
          .update(usersTable)
          .set({
            balanceUsd: sql`${usersTable.balanceUsd} + ${refundStr}`,
          })
          .where(eq(usersTable.id, claimed.renterId))
          .returning({ balanceUsd: usersTable.balanceUsd });

        if (credited) {
          await tx.insert(walletTransactionsTable).values({
            userId: claimed.renterId,
            type: "rental_refund",
            amountUsd: refundStr,
            balanceAfterUsd: toUsdString(round6(toNum(credited.balanceUsd))),
            memo: `Delivery shortfall refund for rental #${claimed.id} (${Math.round((1 - deliveryRatio) * 100)}% undelivered)`,
            relatedRentalId: claimed.id,
          });
        }
      }

      // Mark the rig available again.
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

    // Tear down any live proxy routing now that the rental is done.
    proxyState.getRigSession(rigId)?.deactivateRental();
  }

  return settled;
}
