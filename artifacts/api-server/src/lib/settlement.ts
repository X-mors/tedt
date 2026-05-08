import { and, eq, isNotNull, lte, sql } from "drizzle-orm";
import {
  db,
  rentalsTable,
  rigsTable,
  usersTable,
  walletTransactionsTable,
} from "@workspace/db";
import { round6, toNum, toUsdString, computeDeliveryRatio } from "./money";
import { proxyState } from "./stratum/state";
import { flushAndRemoveRentalWindow } from "./stratum/persistence";
import { logger } from "./logger";

/** Admin window to manually resolve a disputed cancellation. After this the
 *  frozen amount is auto-refunded to the renter ("judgment for the renter"). */
const DISPUTE_AUTO_RESOLVE_MS = 24 * 60 * 60 * 1000;

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
  // Piggy-back the dispute auto-resolver on every settlement sweep so it
  // runs on the same cadence as expiry settlement (every API request that
  // touches rentals, plus admin actions). No separate timer required.
  try {
    await settleExpiredDisputes();
  } catch (err) {
    logger.error({ err }, "settlement: dispute auto-resolver failed");
  }
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

      // Delivery ratio uses the canonical helper from money.ts:
      //  - null deliveredHashrateAvg → 1.0 (proxy never connected, owner not penalised)
      //  - 0    deliveredHashrateAvg → 0.0 (proxy connected, no shares delivered)
      //  - n>0  deliveredHashrateAvg → CLIP(delivered/advertised, 0, 1.05)
      const deliveryRatio = computeDeliveryRatio(
        claimed.deliveredHashrateAvg,
        claimed.hashrate,
      );

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

      // Adjust platformFeeUsd to what the platform actually retained (delivery-scaled).
      await tx
        .update(rentalsTable)
        .set({ platformFeeUsd: toUsdString(round6(toNum(claimed.platformFeeUsd) * deliveryRatio)) })
        .where(eq(rentalsTable.id, claimed.id));

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

    // Tear down ALL live proxy sessions for this rental. Using the plural
    // getSessionsByRentalId ensures every connected worker (e.g. multiple
    // ASICs under the same rig name) returns to the owner's fallback pool.
    // Falling back to getRigSession only when no rentalId-indexed session
    // exists (shadow-rig case or single-device reconnect mid-settle).
    const sessions = proxyState.getSessionsByRentalId(id);
    if (sessions.length > 0) {
      for (const s of sessions) s.deactivateRental();
    } else {
      const fallback = proxyState.getRigSession(rigId);
      if (fallback) {
        fallback.deactivateRental();
      } else {
        // No live session — rig offline at time of settlement. Flush any
        // unflushed share counters first so the renter's UI keeps a complete
        // total post-settlement, then remove the window.
        await flushAndRemoveRentalWindow(id);
      }
    }
  }

  return settled;
}

/**
 * Auto-resolve disputed cancellations whose 24-hour admin window has elapsed.
 * Default outcome: refund the renter the frozen used-time portion (judgment
 * for the renter). Owner receives nothing — they had their chance to await
 * admin review and the rig under-delivered the advertised hashrate.
 *
 * The unused-time portion was already refunded at cancel time; here we only
 * release the frozen used-time portion: renterTotal × usedRatio.
 */
export async function settleExpiredDisputes(): Promise<number> {
  const cutoff = new Date(Date.now() - DISPUTE_AUTO_RESOLVE_MS);

  const expired = await db
    .select({
      id: rentalsTable.id,
      renterId: rentalsTable.renterId,
      renterTotalUsd: rentalsTable.renterTotalUsd,
      startedAt: rentalsTable.startedAt,
      endsAt: rentalsTable.endsAt,
      cancelledAt: rentalsTable.cancelledAt,
      frozenUsd: rentalsTable.frozenUsd,
    })
    .from(rentalsTable)
    .where(
      and(
        eq(rentalsTable.status, "disputed"),
        isNotNull(rentalsTable.cancelledAt),
        lte(rentalsTable.cancelledAt, cutoff),
      ),
    );

  if (expired.length === 0) return 0;

  let resolved = 0;
  for (const r of expired) {
    const ok = await db.transaction(async (tx) => {
      // Atomic claim — only the first concurrent caller wins.
      const [claimed] = await tx
        .update(rentalsTable)
        .set({ status: "cancelled", settledAt: new Date() })
        .where(
          and(
            eq(rentalsTable.id, r.id),
            eq(rentalsTable.status, "disputed"),
          ),
        )
        .returning();
      if (!claimed) return false;

      // Use the frozenUsd stored at dispute creation — consistent with the
      // original split regardless of any later deliveredHashrateAvg updates.
      const frozenRefund = round6(toNum(r.frozenUsd));

      if (frozenRefund > 0) {
        const refundStr = toUsdString(frozenRefund);
        const [credited] = await tx
          .update(usersTable)
          .set({
            balanceUsd: sql`${usersTable.balanceUsd} + ${refundStr}`,
            totalSpentUsd: sql`GREATEST(0, ${usersTable.totalSpentUsd} - ${refundStr})`,
          })
          .where(eq(usersTable.id, r.renterId))
          .returning({ balanceUsd: usersTable.balanceUsd });

        if (credited) {
          await tx.insert(walletTransactionsTable).values({
            userId: r.renterId,
            type: "rental_refund",
            amountUsd: refundStr,
            balanceAfterUsd: toUsdString(round6(toNum(credited.balanceUsd))),
            memo: `Auto-resolved dispute for rental #${r.id} — admin did not respond within 24h, judgment for renter`,
            relatedRentalId: r.id,
          });
        }
      }
      return true;
    });

    if (ok) {
      resolved++;
      logger.info({ rentalId: r.id }, "settlement: auto-resolved dispute for renter");
    }
  }

  return resolved;
}
