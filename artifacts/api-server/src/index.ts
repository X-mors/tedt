import app from "./app";
import { logger } from "./lib/logger";
import { seedDatabase } from "./lib/seed";
import { StratumServer } from "./lib/stratum/server";
import { backfillApprovedRigStatus, backfillRigTokens, backfillStratumNames, backfillOfflinePeriodsFromSamples } from "./lib/backfill";
import { startDepositWorker } from "./lib/depositWorker";
import { settleExpiredRentals } from "./lib/settlement";
import { db, rigsTable, rigOfflinePeriodsTable, rigHashSamplesTable } from "@workspace/db";
import { eq, notInArray, inArray, and, or, isNull, sql } from "drizzle-orm";
import { proxyState } from "./lib/stratum/state";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const stratumPort = Number(process.env["STRATUM_PORT"] ?? "3333");
const stratumLegacyPort = Number(process.env["STRATUM_LEGACY_PORT"] ?? "3334");
// Default port: ASICBoost-capable, accepts only rigs whose algorithm is NOT
// the legacy `sha256` slug (i.e. `sha256asicboost`, `scrypt`, …).
const stratumServer = new StratumServer(stratumPort);
// Legacy port: refuses version-rolling and only accepts rigs listed under
// the legacy `sha256` algorithm — for old ASICs without ASICBoost support.
// Shares the in-process flush loop with the default server (don't double-run).
const stratumLegacyServer = new StratumServer(stratumLegacyPort, {
  legacyMode: true,
  startFlushLoop: false,
});

if (!process.env["NOWPAYMENTS_API_KEY"]) {
  logger.warn("NOWPAYMENTS_API_KEY is not set — crypto deposits and payouts are disabled");
}
if (!process.env["NOWPAYMENTS_IPN_SECRET"]) {
  logger.warn("NOWPAYMENTS_IPN_SECRET is not set — IPN signature verification will reject all webhooks");
}

seedDatabase()
  .then(() => backfillRigTokens())
  .then(() => backfillStratumNames())
  .then(() => backfillApprovedRigStatus())
  .then(() => backfillOfflinePeriodsFromSamples())
  .then(() => db.update(rigsTable).set({ isOnline: false }))
  .then(async () => {
    // Close any open offline periods that may have been left open from a
    // previous unclean shutdown (stratum disconnect handler didn't fire).
    await db
      .update(rigOfflinePeriodsTable)
      .set({ endedAt: new Date() })
      .where(isNull(rigOfflinePeriodsTable.endedAt));
    // Open a fresh offline period for every rig. Use the last hash sample
    // timestamp as startedAt — that's when the rig actually stopped hashing,
    // which is far more accurate than lastSeenAt (which reflects TCP connect
    // time and is often set just seconds before a restart).
    const lastSamplesRaw = await db
      .select({
        rigId: rigHashSamplesTable.rigId,
        lastSampleAt: sql<string>`MAX(${rigHashSamplesTable.sampledAt})`,
      })
      .from(rigHashSamplesTable)
      .groupBy(rigHashSamplesTable.rigId);
    const lastSampleMap = new Map(
      lastSamplesRaw.map((s) => [s.rigId, new Date(s.lastSampleAt)]),
    );
    const rigs = await db.select({ id: rigsTable.id }).from(rigsTable);
    if (rigs.length > 0) {
      await db.insert(rigOfflinePeriodsTable).values(
        rigs.map((r) => ({
          rigId: r.id,
          startedAt: lastSampleMap.get(r.id) ?? new Date(),
        })),
      );
    }
    logger.info("startup: reset all rigs to offline");
  })
  .then(() => {
    stratumServer.start();
    stratumLegacyServer.start();
    startDepositWorker();

    // Settle expired rentals every 2 minutes so they close on time even
    // when the only active poller is /rentals/:id/live (which doesn't call
    // settleExpiredRentals to avoid the overhead on every 5-second tick).
    setInterval(async () => {
      try {
        await settleExpiredRentals();
      } catch (err) {
        logger.warn({ err }, "settlement-cron: failed");
      }
    }, 2 * 60 * 1000).unref();

    // Sync isOnline in DB with actual proxy connections every minute.
    // This corrects any drift (e.g. unclean shutdown, missed _onClose).
    //
    // A listed rig is marked ONLINE only if either:
    //   (a) its own row id appears in `connectedIds` (e.g. it IS the shadow
    //       rig the miner authenticated as), OR
    //   (b) a connected miner authenticated under (ownerId, stratumName) that
    //       exactly matches this listed rig's (ownerId, stratum_name).
    //
    // This replaces the previous fan-out that marked EVERY approved rig of
    // any connected owner as online, which made offline rigs falsely appear
    // online on the marketplace whenever the owner had any other rig mining.
    const SYNC_INTERVAL_MS = 60_000;
    const runOnlineSync = async () => {
      try {
        const connectedIds = proxyState.getConnectedRigIds();
        const identities = proxyState.getConnectedRigIdentities();

        // Snapshot which rigs are currently online BEFORE the sync so we
        // can detect rigs that transition online → offline in this tick.
        const prevOnline = await db
          .select({ id: rigsTable.id })
          .from(rigsTable)
          .where(eq(rigsTable.isOnline, true));
        const prevOnlineIds = new Set(prevOnline.map((r) => r.id));

        await db.update(rigsTable).set({ isOnline: false });

        const idMatch =
          connectedIds.length > 0
            ? inArray(rigsTable.id, connectedIds)
            : null;
        const nameMatches = identities
          .filter((i) => i.rigName)
          .map((i) =>
            and(
              eq(rigsTable.ownerId, i.ownerId),
              eq(rigsTable.stratumName, i.rigName),
              eq(rigsTable.approvalStatus, "approved"),
            ),
          );
        const conditions = [idMatch, ...nameMatches].filter(
          (c): c is NonNullable<typeof c> => c != null,
        );
        const nowOnlineIds = new Set<number>();
        if (conditions.length > 0) {
          const updated = await db
            .update(rigsTable)
            .set({ isOnline: true })
            .where(or(...conditions))
            .returning({ id: rigsTable.id });
          updated.forEach((r) => nowOnlineIds.add(r.id));
        }

        // Rigs that are NOW online → close any open offline period.
        // Safety net for cases where the inline close in downstream.ts
        // failed silently (void call) or the miner reconnected between
        // startup and the first sync tick.
        if (nowOnlineIds.size > 0) {
          await db
            .update(rigOfflinePeriodsTable)
            .set({ endedAt: new Date() })
            .where(
              and(
                inArray(rigOfflinePeriodsTable.rigId, [...nowOnlineIds]),
                isNull(rigOfflinePeriodsTable.endedAt),
              ),
            );
        }

        // Rigs that were online but are no longer → ensure an offline period
        // is open. The disconnect handler already does this with the correct
        // startedAt (last sample timestamp), so we only insert here as a
        // fallback for crash/ungraceful-shutdown cases where the handler
        // didn't fire. Never close+reopen an existing open period — that
        // would reset startedAt to now and break the chart.
        const newlyOfflineIds = [...prevOnlineIds].filter(
          (id) => !nowOnlineIds.has(id),
        );
        if (newlyOfflineIds.length > 0) {
          // Find which of these already have an open period (handler fired).
          const alreadyOpen = await db
            .selectDistinct({ rigId: rigOfflinePeriodsTable.rigId })
            .from(rigOfflinePeriodsTable)
            .where(
              and(
                inArray(rigOfflinePeriodsTable.rigId, newlyOfflineIds),
                isNull(rigOfflinePeriodsTable.endedAt),
              ),
            );
          const alreadyOpenIds = new Set(alreadyOpen.map((r) => r.rigId));
          const needPeriod = newlyOfflineIds.filter((id) => !alreadyOpenIds.has(id));

          for (const rigId of needPeriod) {
            // Use last sample timestamp as startedAt (same logic as disconnect handler).
            const [lastSample] = await db
              .select({ sampledAt: rigHashSamplesTable.sampledAt })
              .from(rigHashSamplesTable)
              .where(eq(rigHashSamplesTable.rigId, rigId))
              .orderBy(desc(rigHashSamplesTable.sampledAt))
              .limit(1);
            const startedAt = lastSample?.sampledAt ?? new Date();
            await db
              .insert(rigOfflinePeriodsTable)
              .values({ rigId, startedAt });
          }
        }

        logger.debug(
          { connectedIds, identities },
          "online-sync: DB synced with proxy state",
        );
      } catch (err) {
        logger.warn({ err }, "online-sync: failed");
      }
    };
    setInterval(runOnlineSync, SYNC_INTERVAL_MS).unref();

    app.listen(port, (err) => {
      if (err) {
        logger.error({ err }, "Error listening on port");
        process.exit(1);
      }
      logger.info({ port }, "Server listening");
    });
  })
  .catch((err) => {
    logger.error({ err }, "Failed to seed database on startup");
    process.exit(1);
  });
