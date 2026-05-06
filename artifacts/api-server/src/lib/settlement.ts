import { and, eq, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import {
  db,
  rentalsTable,
  rigsTable,
  usersTable,
  walletTransactionsTable,
} from "@workspace/db";
import { round6, toNum, toUsdString, computeDeliveryRatio } from "./money";
import { getCommission } from "./commission";
import { proxyState } from "./stratum/state";
import { flushAndRemoveRentalWindow } from "./stratum/persistence";
import { logger } from "./logger";

/** Admin window to manually resolve a disputed rental. After this the
 *  frozen amount is auto-refunded to the renter ("judgment for the renter"). */
const DISPUTE_AUTO_RESOLVE_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Tear down live proxy routing for a rental that has just been settled. */
async function teardownProxy(rentalId: number, rigId: number): Promise<void> {
  const session =
    proxyState.getSessionByRentalId(rentalId) ?? proxyState.getRigSession(rigId);
  if (session) {
    session.deactivateRental();
  } else {
    await flushAndRemoveRentalWindow(rentalId);
  }
}

/** Credit the rig owner and record a payout transaction. */
async function payOwner(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  ownerId: number,
  amountUsd: number,
  memo: string,
  rentalId: number,
): Promise<void> {
  if (amountUsd <= 0) return;
  const str = toUsdString(amountUsd);
  const [credited] = await tx
    .update(usersTable)
    .set({
      balanceUsd: sql`${usersTable.balanceUsd} + ${str}`,
      totalEarnedUsd: sql`${usersTable.totalEarnedUsd} + ${str}`,
    })
    .where(eq(usersTable.id, ownerId))
    .returning({ balanceUsd: usersTable.balanceUsd });
  if (credited) {
    await tx.insert(walletTransactionsTable).values({
      userId: ownerId,
      type: "rental_payout",
      amountUsd: str,
      balanceAfterUsd: toUsdString(round6(toNum(credited.balanceUsd))),
      memo,
      relatedRentalId: rentalId,
    });
  }
}

/** Credit the renter with a refund and record a refund transaction. */
async function refundRenter(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  renterId: number,
  amountUsd: number,
  memo: string,
  rentalId: number,
): Promise<void> {
  if (amountUsd <= 0) return;
  const str = toUsdString(amountUsd);
  const [credited] = await tx
    .update(usersTable)
    .set({
      balanceUsd: sql`${usersTable.balanceUsd} + ${str}`,
    })
    .where(eq(usersTable.id, renterId))
    .returning({ balanceUsd: usersTable.balanceUsd });
  if (credited) {
    await tx.insert(walletTransactionsTable).values({
      userId: renterId,
      type: "rental_refund",
      amountUsd: str,
      balanceAfterUsd: toUsdString(round6(toNum(credited.balanceUsd))),
      memo,
      relatedRentalId: rentalId,
    });
  }
}

// ---------------------------------------------------------------------------
// Scenario 1 — Natural expiry settlement
// ---------------------------------------------------------------------------
/**
 * Settle any active rentals whose `endsAt` has passed.
 *
 * Scenario 1a — delivery ≥ threshold (default 95%):
 *   • Owner paid: ownerEarnings × deliveryRatio
 *   • Renter refunded: renterTotal × (1 − deliveryRatio)   ← small shortfall
 *   • Status: completed
 *
 * Scenario 1b — delivery < threshold:
 *   • Owner paid: ownerEarnings × deliveryRatio  (immediately)
 *   • Renter refund: $0  ← frozen for admin judgment
 *   • Frozen: renterTotal × (1 − deliveryRatio)
 *   • Status: disputed  (auto-released to renter after 24 h if admin inactive)
 */
export async function settleExpiredRentals(): Promise<number> {
  // Run sub-jobs first so they share the same sweep cadence.
  try { await settleExpiredDisputes(); } catch (err) {
    logger.error({ err }, "settlement: dispute auto-resolver failed");
  }
  try { await settleOfflineRigs(); } catch (err) {
    logger.error({ err }, "settlement: offline-rig auto-terminate failed");
  }

  const c = await getCommission();
  const deliveryThreshold = c.deliveryThresholdPct / 100;
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
      // Claim atomically — only the first concurrent caller wins.
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

      const deliveryRatio = computeDeliveryRatio(
        claimed.deliveredHashrateAvg,
        claimed.hashrate,
      );

      const ownerPayout = round6(toNum(claimed.ownerEarningsUsd) * deliveryRatio);
      const platformFeeEarned = round6(toNum(claimed.platformFeeUsd) * deliveryRatio);

      if (deliveryRatio >= deliveryThreshold) {
        // ── Scenario 1a: clean natural expiry ──────────────────────────────
        const renterRefund = round6(toNum(claimed.renterTotalUsd) * (1 - deliveryRatio));

        await payOwner(
          tx, claimed.ownerId, ownerPayout,
          `Payout for rental #${claimed.id} (${Math.round(deliveryRatio * 100)}% delivery)`,
          claimed.id,
        );
        await refundRenter(
          tx, claimed.renterId, renterRefund,
          `Delivery shortfall refund for rental #${claimed.id} (${Math.round((1 - deliveryRatio) * 100)}% undelivered)`,
          claimed.id,
        );
        await tx
          .update(rentalsTable)
          .set({ platformFeeUsd: toUsdString(platformFeeEarned) })
          .where(eq(rentalsTable.id, claimed.id));
      } else {
        // ── Scenario 1b: low delivery → freeze shortfall for admin ─────────
        const frozenAmount = round6(toNum(claimed.renterTotalUsd) * (1 - deliveryRatio));

        // Switch status back to "disputed"; the completed claim was only for the lock.
        await tx
          .update(rentalsTable)
          .set({
            status: "disputed",
            settledAt: null,
            frozenUsd: toUsdString(frozenAmount),
            platformFeeUsd: toUsdString(platformFeeEarned),
          })
          .where(eq(rentalsTable.id, claimed.id));

        await payOwner(
          tx, claimed.ownerId, ownerPayout,
          `Partial payout for rental #${claimed.id} (${Math.round(deliveryRatio * 100)}% delivered, ${Math.round(deliveryThreshold * 100)}% required). $${frozenAmount.toFixed(6)} frozen for admin review.`,
          claimed.id,
        );

        // Audit marker — the frozen amount is NOT yet transferred anywhere.
        await tx.insert(walletTransactionsTable).values({
          userId: claimed.renterId,
          type: "rental_dispute",
          amountUsd: "0.000000",
          balanceAfterUsd: toUsdString(0),
          memo: `Natural-expiry dispute: rental #${claimed.id} delivered ${Math.round(deliveryRatio * 100)}% (below ${Math.round(deliveryThreshold * 100)}% threshold). $${frozenAmount.toFixed(6)} frozen pending admin judgment. Auto-refunds to renter in 24h if unresolved.`,
          relatedRentalId: claimed.id,
        });
      }

      // Mark rig available again regardless of settlement path.
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
    await teardownProxy(id, rigId);
  }

  return settled;
}

// ---------------------------------------------------------------------------
// Scenario 2 — Rig offline auto-terminate
// ---------------------------------------------------------------------------
/**
 * Terminate active rentals whose rig has been offline (no shares) for longer
 * than `rigOfflineTerminateMins`.  Setting this to 0 disables the feature.
 *
 * Settlement (no penalty, no dispute):
 *   • Owner paid: ownerEarnings × usedRatio × deliveryRatio
 *   • Renter refunded: renterTotal − (owner + platform earned)
 *   • Platform: platformFee × usedRatio × deliveryRatio
 *   • Status: cancelled
 */
export async function settleOfflineRigs(): Promise<number> {
  const c = await getCommission();
  const { rigOfflineTerminateMins } = c;
  if (rigOfflineTerminateMins <= 0) return 0; // feature disabled

  const cutoff = new Date(Date.now() - rigOfflineTerminateMins * 60 * 1000);
  const now = new Date();

  // Find active rentals with a known lastShareAt that predates the cutoff.
  // (lastShareAt = null means the proxy never connected — do NOT auto-terminate
  //  those; let them run to natural expiry so the owner isn't penalised for
  //  network/proxy issues on the platform side.)
  const stale = await db
    .select({
      id: rentalsTable.id,
      rigId: rentalsTable.rigId,
      renterId: rentalsTable.renterId,
      ownerId: rentalsTable.ownerId,
      renterTotalUsd: rentalsTable.renterTotalUsd,
      ownerEarningsUsd: rentalsTable.ownerEarningsUsd,
      platformFeeUsd: rentalsTable.platformFeeUsd,
      startedAt: rentalsTable.startedAt,
      endsAt: rentalsTable.endsAt,
      deliveredHashrateAvg: rentalsTable.deliveredHashrateAvg,
      hashrate: rentalsTable.hashrate,
    })
    .from(rentalsTable)
    .where(
      and(
        eq(rentalsTable.status, "active"),
        isNotNull(rentalsTable.lastShareAt),
        lte(rentalsTable.lastShareAt, cutoff),
      ),
    );

  if (stale.length === 0) return 0;
  let terminated = 0;

  for (const r of stale) {
    const ok = await db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(rentalsTable)
        .set({ status: "cancelled", cancelledAt: now, settledAt: now })
        .where(
          and(
            eq(rentalsTable.id, r.id),
            eq(rentalsTable.status, "active"),
          ),
        )
        .returning();
      if (!claimed) return false;

      const totalSec = Math.max(
        1,
        (r.endsAt.getTime() - r.startedAt.getTime()) / 1000,
      );
      const usedSec = Math.min(
        totalSec,
        Math.max(0, (now.getTime() - r.startedAt.getTime()) / 1000),
      );
      const usedRatio = usedSec / totalSec;
      const deliveryRatio = computeDeliveryRatio(
        r.deliveredHashrateAvg,
        r.hashrate,
      );

      // ownerPayout + platformFeeEarned = effective paid portion of renterTotal
      const ownerPayout = round6(toNum(r.ownerEarningsUsd) * usedRatio * deliveryRatio);
      const platformFeeEarned = round6(toNum(r.platformFeeUsd) * usedRatio * deliveryRatio);
      const renterRefund = round6(toNum(r.renterTotalUsd) - ownerPayout - platformFeeEarned);

      await tx
        .update(rentalsTable)
        .set({ platformFeeUsd: toUsdString(platformFeeEarned) })
        .where(eq(rentalsTable.id, r.id));

      await payOwner(
        tx, r.ownerId, ownerPayout,
        `Rig-offline auto-termination payout for rental #${r.id} — ${Math.round(usedRatio * 100)}% elapsed, ${Math.round(deliveryRatio * 100)}% delivery. No penalty applied.`,
        r.id,
      );
      await refundRenter(
        tx, r.renterId, renterRefund,
        `Rig-offline auto-termination refund for rental #${r.id} — rig was offline for >${rigOfflineTerminateMins} min. Refunded unused + undelivered portion ($${renterRefund.toFixed(6)}).`,
        r.id,
      );

      await tx
        .update(rigsTable)
        .set({ status: "available" })
        .where(
          and(
            eq(rigsTable.id, r.rigId),
            eq(rigsTable.status, "rented"),
          ),
        );

      return true;
    });

    if (ok) {
      terminated++;
      logger.info(
        { rentalId: r.id, rigId: r.rigId, cutoffMins: rigOfflineTerminateMins },
        "settlement: auto-terminated rental — rig offline",
      );
      await teardownProxy(r.id, r.rigId);
    }
  }

  return terminated;
}

// ---------------------------------------------------------------------------
// Auto-resolve disputes after 24 h (admin did not act)
// ---------------------------------------------------------------------------
/**
 * Auto-resolve any disputed rentals whose 24-hour admin window has elapsed.
 * Default outcome: refund the frozen amount to the renter.
 *
 * Covers both:
 *   • Manual-cancel disputes  (cancelledAt set)
 *   • Natural-expiry disputes (cancelledAt null, endsAt passed)
 */
export async function settleExpiredDisputes(): Promise<number> {
  const cutoff = new Date(Date.now() - DISPUTE_AUTO_RESOLVE_MS);

  const expired = await db
    .select({
      id: rentalsTable.id,
      renterId: rentalsTable.renterId,
      frozenUsd: rentalsTable.frozenUsd,
    })
    .from(rentalsTable)
    .where(
      and(
        eq(rentalsTable.status, "disputed"),
        or(
          // Manual-cancel dispute: use cancelledAt as the 24h reference.
          and(isNotNull(rentalsTable.cancelledAt), lte(rentalsTable.cancelledAt, cutoff)),
          // Natural-expiry dispute: use endsAt as the 24h reference.
          and(isNull(rentalsTable.cancelledAt), lte(rentalsTable.endsAt, cutoff)),
        ),
      ),
    );

  if (expired.length === 0) return 0;

  let resolved = 0;
  for (const r of expired) {
    const ok = await db.transaction(async (tx) => {
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

      const frozenRefund = round6(toNum(r.frozenUsd));

      await refundRenter(
        tx, r.renterId, frozenRefund,
        `Auto-resolved dispute for rental #${r.id} — admin did not respond within 24h, judgment for renter`,
        r.id,
      );

      return true;
    });

    if (ok) {
      resolved++;
      logger.info({ rentalId: r.id }, "settlement: auto-resolved dispute for renter");
    }
  }

  return resolved;
}
