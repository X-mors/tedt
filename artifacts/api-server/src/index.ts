import app from "./app";
import { logger } from "./lib/logger";
import { seedDatabase } from "./lib/seed";
import { StratumServer } from "./lib/stratum/server";
import { backfillApprovedRigStatus, backfillRigTokens, backfillStratumNames } from "./lib/backfill";
import { startDepositWorker } from "./lib/depositWorker";
import { db, rigsTable } from "@workspace/db";
import { eq, notInArray, inArray, and, or } from "drizzle-orm";
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
  tlsCertPath: process.env["STRATUM_TLS_CERT"] ?? undefined,
  tlsKeyPath: process.env["STRATUM_TLS_KEY"] ?? undefined,
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
  .then(() => db.update(rigsTable).set({ isOnline: false }))
  .then(() => logger.info("startup: reset all rigs to offline"))
  .then(() => {
    stratumServer.start();
    stratumLegacyServer.start();
    startDepositWorker();

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
        if (conditions.length > 0) {
          await db
            .update(rigsTable)
            .set({ isOnline: true })
            .where(or(...conditions));
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
