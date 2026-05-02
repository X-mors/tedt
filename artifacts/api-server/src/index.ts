import app from "./app";
import { logger } from "./lib/logger";
import { seedDatabase } from "./lib/seed";
import { StratumServer } from "./lib/stratum/server";
import { backfillApprovedRigStatus, backfillRigTokens, backfillStratumNames } from "./lib/backfill";
import { startDepositWorker } from "./lib/depositWorker";
import { db, rigsTable } from "@workspace/db";
import { eq, notInArray, inArray } from "drizzle-orm";
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
const stratumServer = new StratumServer(stratumPort);

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
    startDepositWorker();

    // Sync isOnline in DB with actual proxy connections every 5 minutes.
    // This corrects any drift (e.g. unclean shutdown, missed _onClose).
    const SYNC_INTERVAL_MS = 5 * 60_000;
    setInterval(async () => {
      try {
        const connectedIds = proxyState.getConnectedRigIds();
        if (connectedIds.length > 0) {
          await db.update(rigsTable).set({ isOnline: true }).where(inArray(rigsTable.id, connectedIds));
          await db.update(rigsTable).set({ isOnline: false }).where(notInArray(rigsTable.id, connectedIds));
        } else {
          await db.update(rigsTable).set({ isOnline: false });
        }
        logger.debug({ connectedIds }, "online-sync: DB synced with proxy state");
      } catch (err) {
        logger.warn({ err }, "online-sync: failed");
      }
    }, SYNC_INTERVAL_MS).unref();

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
