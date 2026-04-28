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
import { round6, toNum, toUsdString, unitMultiplier } from "../money";

const FLUSH_INTERVAL_MS = 60_000;
const LOW_DELIVERY_THRESHOLD = 0.70;
const LOW_DELIVERY_WINDOW_SECS = 1800;
const MIN_SHARES_FOR_LOW_DELIVERY_CHECK = 5;

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

        if (snapshot.sharesAccepted > 0) {
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
        }

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
    const [rental] = await db
      .select({
        id: rentalsTable.id,
        hashrate: rentalsTable.hashrate,
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
    if (elapsedMs < LOW_DELIVERY_WINDOW_SECS * 1000) return;

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
            new Date(Date.now() - LOW_DELIVERY_WINDOW_SECS * 1000),
          ),
        ),
      );

    const totalShares = recentSamples.reduce(
      (s, r) => s + r.sharesAccepted,
      0,
    );
    if (totalShares < MIN_SHARES_FOR_LOW_DELIVERY_CHECK) return;

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

    if (ratio < LOW_DELIVERY_THRESHOLD) {
      logger.warn(
        { rentalId, ratio, avgHashrateH, advertisedH },
        "stratum:server low delivery — auto-cancelling rental",
      );
      await this._autoCancelRental(rental);
    }
  }

  private async _autoCancelRental(rental: {
    id: number;
    renterTotalUsd: string;
    ownerEarningsUsd: string;
    renterId: number;
    ownerId: number;
    rigId: number;
    startedAt: Date;
    endsAt: Date;
  }): Promise<void> {
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

        await tx
          .update(rigsTable)
          .set({ status: "available" })
          .where(eq(rigsTable.id, rental.rigId));

        const totalSecs =
          (rental.endsAt.getTime() - rental.startedAt.getTime()) / 1000;
        const usedSecs = Math.max(
          0,
          (now.getTime() - rental.startedAt.getTime()) / 1000,
        );
        const usedRatio = totalSecs > 0 ? usedSecs / totalSecs : 1;
        const refund = round6(
          toNum(rental.renterTotalUsd) * (1 - usedRatio),
        );

        if (refund > 0) {
          const refundStr = toUsdString(refund);
          const [credited] = await tx
            .update(usersTable)
            .set({
              balanceUsd: sql`${usersTable.balanceUsd} + ${refundStr}`,
            })
            .where(eq(usersTable.id, rental.renterId))
            .returning({ balanceUsd: usersTable.balanceUsd });
          if (credited) {
            await tx.insert(walletTransactionsTable).values({
              userId: rental.renterId,
              type: "rental_refund",
              amountUsd: refundStr,
              balanceAfterUsd: toUsdString(
                round6(toNum(credited.balanceUsd)),
              ),
              memo: `Auto-cancelled: low hashrate delivery — refund for rental #${rental.id}`,
              relatedRentalId: rental.id,
            });
          }
        }
      });

      proxyState.forceDisconnect(rental.rigId);
    } catch (err) {
      logger.error(
        { err, rentalId: rental.id },
        "stratum:server auto-cancel error",
      );
    }
  }
}
