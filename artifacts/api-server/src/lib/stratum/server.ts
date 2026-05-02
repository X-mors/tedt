import * as net from "node:net";
import { and, eq, gte, sql } from "drizzle-orm";
import {
  db,
  rentalsTable,
  rentalHashSamplesTable,
  rigsTable,
  algorithmsTable,
  usersTable,
  walletTransactionsTable,
} from "@workspace/db";
import { logger } from "../logger";
import { proxyState } from "./state";
import { DownstreamSession } from "./downstream";
import { round6, toNum, toUsdString, unitMultiplier, computeDeliveryRatio } from "../money";
import { getProxySettings } from "../platformSettings";

const FLUSH_INTERVAL_MS = 60_000;

export class StratumServer {
  private tcpServer: net.Server;
  private flushTimer: NodeJS.Timeout | null = null;
  private algUnitCache = new Map<number, string>();

  constructor(private readonly port: number) {
    this.tcpServer = net.createServer((socket: net.Socket) => {
      logger.info(
        { remoteAddress: socket.remoteAddress },
        "stratum:server new connection",
      );
      new DownstreamSession(socket);
    });

    this.tcpServer.on("error", (err: Error) => {
      logger.error({ err }, "stratum:server TCP error");
    });
  }

  start(): void {
    this.tcpServer.listen(this.port, "0.0.0.0", () => {
      logger.info({ port: this.port }, "stratum:server listening");
    });
    this.flushTimer = setInterval(() => {
      void this._flushSamples();
    }, FLUSH_INTERVAL_MS);
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
    const windows = proxyState.getAllWindows();
    if (windows.length === 0) return;

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

        // Always update deliveredHashrateAvg — including zero-share windows
        // so stale highs from a previous active period are corrected downward.
        const algUnit = await this._getAlgUnit(snapshot.rentalId);
        const multiplier = unitMultiplier(algUnit);
        await db
          .update(rentalsTable)
          .set({
            deliveredHashrateAvg: sql`(
              SELECT AVG(effective_hashrate_h) / ${multiplier}
              FROM rental_hash_samples
              WHERE rental_id = ${snapshot.rentalId}
                AND sampled_at > NOW() - INTERVAL '3 hours'
            )`,
          })
          .where(eq(rentalsTable.id, snapshot.rentalId));

        await this._checkLowDelivery(snapshot.rentalId);
      } catch (err) {
        logger.error(
          { err, rentalId: snapshot.rentalId },
          "stratum:server flush error",
        );
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
        effectiveHashrateH: rentalHashSamplesTable.effectiveHashrateH,
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
    if (totalShares < minSharesForCheck) return;

    const avgHashrateH =
      recentSamples.reduce(
        (s, r) => s + toNum(r.effectiveHashrateH ?? "0"),
        0,
      ) / Math.max(1, recentSamples.length);
    if (avgHashrateH === 0) return;

    const algUnit = await this._getAlgUnit(rentalId);
    const mult = unitMultiplier(algUnit);
    const advertisedH = toNum(rental.hashrate) * mult;
    const ratio = avgHashrateH / advertisedH;

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

        // Flag rig for admin review — low delivery auto-cancel requires manual re-approval.
        await tx
          .update(rigsTable)
          .set({
            status: "offline",
            approvalStatus: "pending",
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

      // Remove share window and evict algUnit cache for the ended rental.
      proxyState.removeShareWindow(rental.id);
      this.algUnitCache.delete(rental.id);
      proxyState.forceDisconnect(rental.rigId);
    } catch (err) {
      logger.error(
        { err, rentalId: rental.id },
        "stratum:server auto-cancel error",
      );
    }
  }
}
