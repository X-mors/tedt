import * as net from "node:net";
import { and, eq, gte, sql } from "drizzle-orm";
import {
  db,
  rentalsTable,
  rentalHashSamplesTable,
  rigHashSamplesTable,
  rigsTable,
  algorithmsTable,
  usersTable,
  walletTransactionsTable,
} from "@workspace/db";
import { lt } from "drizzle-orm";
import { logger } from "../logger";
import { proxyState } from "./state";
import { DownstreamSession } from "./downstream";
import { round6, toNum, toUsdString, unitMultiplier, computeDeliveryRatio } from "../money";
import { getProxySettings } from "../platformSettings";

import { persistRentalShareDelta, flushAndRemoveRentalWindow } from "./persistence";

const FLUSH_INTERVAL_MS = 60_000;
/** Maximum age of per-rig samples retained for owner-side history charts. */
const RIG_SAMPLE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
/** Run retention prune at most every hour to avoid hammering the DB. */
const RIG_SAMPLE_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export class StratumServer {
  private tcpServer: net.Server;
  private flushTimer: NodeJS.Timeout | null = null;
  private algUnitCache = new Map<number, string>();
  private lastRigSamplePruneMs = 0;

  private readonly legacyMode: boolean;
  /**
   * @param port      TCP port to listen on.
   * @param options   `legacyMode` true → refuse ASICBoost / version-rolling and
   *                  only accept rigs listed under the `sha256` algorithm.
   *                  Used to expose a separate listener for legacy hardware.
   *                  `startFlushLoop` false → skip the periodic sample-flush
   *                  loop. Set on secondary listeners so we don't double-flush.
   */
  constructor(
    private readonly port: number,
    options: { legacyMode?: boolean; startFlushLoop?: boolean } = {},
  ) {
    this.legacyMode = options.legacyMode === true;
    const startFlushLoop = options.startFlushLoop !== false;
    this.tcpServer = net.createServer((socket: net.Socket) => {
      logger.info(
        { remoteAddress: socket.remoteAddress, legacyMode: this.legacyMode },
        "stratum:server new connection",
      );
      new DownstreamSession(socket, { legacyMode: this.legacyMode });
    });

    this.tcpServer.on("error", (err: Error) => {
      logger.error({ err, legacyMode: this.legacyMode }, "stratum:server TCP error");
    });
    this._startFlushLoop = startFlushLoop;
  }

  private readonly _startFlushLoop: boolean;

  start(): void {
    this.tcpServer.listen(this.port, "0.0.0.0", () => {
      logger.info({ port: this.port, legacyMode: this.legacyMode }, "stratum:server listening");
    });
    if (this._startFlushLoop) {
      this.flushTimer = setInterval(() => {
        void this._flushSamples();
      }, FLUSH_INTERVAL_MS);
    }
  }

  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.tcpServer.close();
  }

  private async _getAlgUnit(rentalId: number): Promise<string> {
    const cached = this.algUnitCache.get(rentalId);
    if (cached) return cached;
    const [row] = await db
      .select({ unit: algorithmsTable.unit })
      .from(rentalsTable)
      .innerJoin(rigsTable, eq(rigsTable.id, rentalsTable.rigId))
      .innerJoin(algorithmsTable, eq(algorithmsTable.id, rigsTable.algorithmId))
      .where(eq(rentalsTable.id, rentalId));
    const unit = row?.unit ?? "TH/s";
    this.algUnitCache.set(rentalId, unit);
    return unit;
  }

  private async _flushSamples(): Promise<void> {
    // Track which rigs we've already written a per-rig sample for during
    // this flush cycle so the rental loop and the fallback loop don't
    // double-insert if a rig somehow appears in both maps.
    const rigSampledThisCycle = new Set<number>();
    // Track which rentals had _checkLowDelivery actually invoked so the
    // post-loop sweep can skip them. NOTE: we add only on real calls below,
    // NOT for every window — windows whose snapshot is null produce no
    // shares this cycle and must still be evaluated by the sweep.
    const lowDeliveryCheckedThisCycle = new Set<number>();

    const windows = proxyState.getAllWindows();
    for (const window of windows) {
      const snapshot = proxyState.flushAndResetWindow(window.rentalId);
      if (!snapshot) continue;

      const elapsedSec = Math.max(
        1,
        (Date.now() - snapshot.startedAt) / 1000,
      );
      const effectiveHashrateH =
        (snapshot.difficultySum * 4294967296) / elapsedSec;

      try {
        await db.insert(rentalHashSamplesTable).values({
          rentalId: snapshot.rentalId,
          windowSeconds: Math.round(elapsedSec),
          sharesAccepted: snapshot.sharesAccepted,
          sharesRejected: snapshot.sharesRejected,
          difficultySum: String(snapshot.difficultySum),
          effectiveHashrateH: String(effectiveHashrateH),
        });
        // Mirror into the per-rig stream so the owner gets a continuous
        // history regardless of rental state. rentalId is set so the owner
        // chart can highlight rental periods in yellow.
        await db.insert(rigHashSamplesTable).values({
          rigId: snapshot.rigId,
          rentalId: snapshot.rentalId,
          windowSeconds: Math.round(elapsedSec),
          sharesAccepted: snapshot.sharesAccepted,
          sharesRejected: snapshot.sharesRejected,
          effectiveHashrateH: String(effectiveHashrateH),
        });
        rigSampledThisCycle.add(snapshot.rigId);

        // Update deliveredHashrateAvg using a TIME-WEIGHTED average:
        // total hashes delivered since rental start ÷ elapsed seconds.
        // This correctly accounts for offline gaps — silent periods
        // contribute 0 hashes and pull the average down naturally.
        // Using the outer rentals.started_at in the correlated subquery
        // avoids an extra round-trip to fetch the rental row.
        const algUnit = await this._getAlgUnit(snapshot.rentalId);
        const multiplier = unitMultiplier(algUnit);
        await db
          .update(rentalsTable)
          .set({
            deliveredHashrateAvg: sql`(
              SELECT COALESCE(SUM(s.difficulty_sum::numeric * 4294967296), 0)
                     / GREATEST(1, EXTRACT(EPOCH FROM (NOW() - rentals.started_at)))
                     / ${multiplier}
              FROM rental_hash_samples s
              WHERE s.rental_id = ${snapshot.rentalId}
            )`,
          })
          .where(eq(rentalsTable.id, snapshot.rentalId));

        // Persist cumulative share counters on the rentals row so the
        // renter's live UI survives server restarts. Done as a separate,
        // commit-after-success step so a transient failure here doesn't
        // drop deltas — they stay in-memory for the next flush.
        await persistRentalShareDelta(snapshot.rentalId);

        await this._checkLowDelivery(snapshot.rentalId);
        lowDeliveryCheckedThisCycle.add(snapshot.rentalId);
      } catch (err) {
        logger.error(
          { err, rentalId: snapshot.rentalId },
          "stratum:server flush error",
        );
      }
    }

    // Sweep ALL active rentals (not just those that produced shares this
    // cycle) so that a totally-disconnected rig — which never enters the
    // snapshot loop above — still gets evaluated and auto-cancelled when
    // its delivery is below the admin threshold.
    try {
      const activeRentals = await db
        .select({ id: rentalsTable.id })
        .from(rentalsTable)
        .where(eq(rentalsTable.status, "active"));
      for (const r of activeRentals) {
        if (lowDeliveryCheckedThisCycle.has(r.id)) continue;
        await this._checkLowDelivery(r.id);
        // Also keep deliveredHashrateAvg current for offline rentals so the
        // renter UI shows a declining average while the rig is disconnected.
        const algUnit = await this._getAlgUnit(r.id);
        const multiplier = unitMultiplier(algUnit);
        await db
          .update(rentalsTable)
          .set({
            deliveredHashrateAvg: sql`(
              SELECT COALESCE(SUM(s.difficulty_sum::numeric * 4294967296), 0)
                     / GREATEST(1, EXTRACT(EPOCH FROM (NOW() - rentals.started_at)))
                     / ${multiplier}
              FROM rental_hash_samples s
              WHERE s.rental_id = ${r.id}
            )`,
          })
          .where(eq(rentalsTable.id, r.id));
      }
    } catch (err) {
      logger.error(
        { err },
        "stratum:server low-delivery sweep error",
      );
    }

    // Per-rig fallback samples — for rigs mining to the owner's pool with
    // no active rental. These never reach the rental table but are
    // essential for the owner's continuous 14-day history chart.
    for (const rigId of proxyState.getFallbackRigIds()) {
      if (rigSampledThisCycle.has(rigId)) continue;
      const snap = proxyState.flushFallbackSnapshot(rigId);
      if (!snap) continue;
      const elapsedSec = Math.max(1, (Date.now() - snap.startedAt) / 1000);
      const effectiveHashrateH =
        (snap.difficultySum * 4294967296) / elapsedSec;
      try {
        await db.insert(rigHashSamplesTable).values({
          rigId,
          rentalId: null,
          windowSeconds: Math.round(elapsedSec),
          sharesAccepted: snap.sharesAccepted,
          sharesRejected: snap.sharesRejected,
          effectiveHashrateH: String(effectiveHashrateH),
        });
      } catch (err) {
        logger.error(
          { err, rigId },
          "stratum:server fallback flush error",
        );
      }
    }

    // Retention: prune per-rig samples older than the retention window.
    // Cheap to run hourly — uses the (rig_id, sampled_at) index.
    if (Date.now() - this.lastRigSamplePruneMs >= RIG_SAMPLE_PRUNE_INTERVAL_MS) {
      this.lastRigSamplePruneMs = Date.now();
      try {
        await db
          .delete(rigHashSamplesTable)
          .where(
            lt(
              rigHashSamplesTable.sampledAt,
              new Date(Date.now() - RIG_SAMPLE_RETENTION_MS),
            ),
          );
      } catch (err) {
        logger.error({ err }, "stratum:server rig sample prune error");
      }
    }
  }

  private async _checkLowDelivery(rentalId: number): Promise<void> {
    // Read admin-configurable thresholds on each check (cached 60 s).
    const settings = await getProxySettings();
    const { lowDeliveryThresholdPct, lowDeliveryWindowSec, minSharesForCheck } = settings;

    const [rental] = await db
      .select({
        id: rentalsTable.id,
        hashrate: rentalsTable.hashrate,
        deliveredHashrateAvg: rentalsTable.deliveredHashrateAvg,
        renterTotalUsd: rentalsTable.renterTotalUsd,
        ownerEarningsUsd: rentalsTable.ownerEarningsUsd,
        startedAt: rentalsTable.startedAt,
        endsAt: rentalsTable.endsAt,
        renterId: rentalsTable.renterId,
        ownerId: rentalsTable.ownerId,
        rigId: rentalsTable.rigId,
        status: rentalsTable.status,
      })
      .from(rentalsTable)
      .where(
        and(
          eq(rentalsTable.id, rentalId),
          eq(rentalsTable.status, "active"),
        ),
      );
    if (!rental) return;

    const elapsedMs = Date.now() - rental.startedAt.getTime();
    if (elapsedMs < lowDeliveryWindowSec * 1000) return;

    const recentSamples = await db
      .select({
        sharesAccepted: rentalHashSamplesTable.sharesAccepted,
        difficultySum: rentalHashSamplesTable.difficultySum,
        windowSeconds: rentalHashSamplesTable.windowSeconds,
      })
      .from(rentalHashSamplesTable)
      .where(
        and(
          eq(rentalHashSamplesTable.rentalId, rentalId),
          gte(
            rentalHashSamplesTable.sampledAt,
            new Date(Date.now() - lowDeliveryWindowSec * 1000),
          ),
        ),
      );

    const totalShares = recentSamples.reduce(
      (s, r) => s + r.sharesAccepted,
      0,
    );

    // Time-weighted average: total hashes delivered in the window divided by
    // the full window duration. Silent gaps (disconnected rig) count as zero
    // so a rig that was offline for half the window shows ~50% delivery.
    const totalHashesInWindow = recentSamples.reduce(
      (s, r) => s + toNum(r.difficultySum) * 4294967296,
      0,
    );
    const avgHashrateH = totalHashesInWindow / lowDeliveryWindowSec;

    const algUnit = await this._getAlgUnit(rentalId);
    const mult = unitMultiplier(algUnit);
    const advertisedH = toNum(rental.hashrate) * mult;
    const ratio = advertisedH > 0 ? avgHashrateH / advertisedH : 1;

    // Skip if too few shares to make a meaningful judgment — unless the rig
    // has been completely silent for the entire window (totally dark), in
    // which case we treat it as 0% delivery regardless.
    const totallyDark = recentSamples.length === 0;
    if (!totallyDark && totalShares < minSharesForCheck) return;

    if (ratio < lowDeliveryThresholdPct) {
      logger.warn(
        { rentalId, ratio, avgHashrateH, advertisedH },
        "stratum:server low delivery — auto-cancelling rental",
      );
      await this._autoCancelRental(rental, lowDeliveryThresholdPct);
    }
  }

  private async _autoCancelRental(
    rental: {
      id: number;
      hashrate: string;
      deliveredHashrateAvg: string | null;
      renterTotalUsd: string;
      ownerEarningsUsd: string;
      renterId: number;
      ownerId: number;
      rigId: number;
      startedAt: Date;
      endsAt: Date;
    },
    thresholdPct: number,
  ): Promise<void> {
    try {
      await db.transaction(async (tx) => {
        const now = new Date();
        const [claimed] = await tx
          .update(rentalsTable)
          .set({ status: "cancelled", cancelledAt: now, settledAt: now })
          .where(
            and(
              eq(rentalsTable.id, rental.id),
              eq(rentalsTable.status, "active"),
            ),
          )
          .returning();
        if (!claimed) return;

        // Mark the rig offline but DO NOT change its approval status — the
        // owner has already been approved and forcing re-approval blocks
        // them from re-listing without admin action. We still record the
        // reason as an approvalNote for the admin's audit trail.
        await tx
          .update(rigsTable)
          .set({
            status: "offline",
            approvalNote: `Auto-cancelled rental #${rental.id}: sustained hashrate below ${Math.round(thresholdPct * 100)}% of advertised value.`,
          })
          .where(eq(rigsTable.id, rental.rigId));

        // Delivery-based settlement — mirrors the cancel-route reconciliation.
        // deliveryRatio: delivered vs. advertised hashrate (capped at 1.05 for slight overperformance).
        // usedRatio:     elapsed time vs. total booked time.
        // effectiveRatio = deliveryRatio × usedRatio — owner earns this fraction, renter gets the rest.
        const totalSecs =
          (rental.endsAt.getTime() - rental.startedAt.getTime()) / 1000;
        const usedSecs = Math.max(
          0,
          Math.min(totalSecs, (now.getTime() - rental.startedAt.getTime()) / 1000),
        );
        const usedRatio = totalSecs > 0 ? usedSecs / totalSecs : 1;

        const deliveryRatio = computeDeliveryRatio(
          rental.deliveredHashrateAvg,
          rental.hashrate,
        );

        const effectiveRatio = deliveryRatio * usedRatio;
        const ownerPayout = round6(toNum(rental.ownerEarningsUsd) * effectiveRatio);
        const renterRefund = round6(toNum(rental.renterTotalUsd) * (1 - effectiveRatio));

        if (renterRefund > 0) {
          const refundStr = toUsdString(renterRefund);
          const [credited] = await tx
            .update(usersTable)
            .set({
              balanceUsd: sql`${usersTable.balanceUsd} + ${refundStr}`,
              totalSpentUsd: sql`GREATEST(0, ${usersTable.totalSpentUsd} - ${refundStr})`,
            })
            .where(eq(usersTable.id, rental.renterId))
            .returning({ balanceUsd: usersTable.balanceUsd });
          if (credited) {
            await tx.insert(walletTransactionsTable).values({
              userId: rental.renterId,
              type: "rental_refund",
              amountUsd: refundStr,
              balanceAfterUsd: toUsdString(round6(toNum(credited.balanceUsd))),
              memo: `Auto-cancel refund for rental #${rental.id}: ${Math.round(deliveryRatio * 100)}% hashrate × ${Math.round(usedRatio * 100)}% time = ${Math.round(effectiveRatio * 100)}% value delivered`,
              relatedRentalId: rental.id,
            });
          }
        }

        if (ownerPayout > 0) {
          const payoutStr = toUsdString(ownerPayout);
          const [credited] = await tx
            .update(usersTable)
            .set({
              balanceUsd: sql`${usersTable.balanceUsd} + ${payoutStr}`,
              totalEarnedUsd: sql`${usersTable.totalEarnedUsd} + ${payoutStr}`,
            })
            .where(eq(usersTable.id, rental.ownerId))
            .returning({ balanceUsd: usersTable.balanceUsd });
          if (credited) {
            await tx.insert(walletTransactionsTable).values({
              userId: rental.ownerId,
              type: "rental_payout",
              amountUsd: payoutStr,
              balanceAfterUsd: toUsdString(round6(toNum(credited.balanceUsd))),
              memo: `Auto-cancel payout for rental #${rental.id}: ${Math.round(deliveryRatio * 100)}% delivery × ${Math.round(usedRatio * 100)}% time used`,
              relatedRentalId: rental.id,
            });
          }
        }
      });

      // Tear down live proxy routing — destroys upstream pool connection,
      // clears rentalId, force-closes miner socket so it reconnects to the
      // owner's fallback pool. Look up by rentalId to handle shadow rigs
      // (auto-created when miner uses a non-matching stratumName).
      const session =
        proxyState.getSessionByRentalId(rental.id) ??
        proxyState.getRigSession(rental.rigId);
      if (session) {
        // deactivateRental will flush + remove the share window itself.
        session.deactivateRental();
      } else {
        // No live session — flush unflushed counters before removing.
        await flushAndRemoveRentalWindow(rental.id);
      }
      this.algUnitCache.delete(rental.id);
    } catch (err) {
      logger.error(
        { err, rentalId: rental.id },
        "stratum:server auto-cancel error",
      );
    }
  }
}
