import app from "./app";
import { logger } from "./lib/logger";
import { seedDatabase } from "./lib/seed";
import { StratumServer } from "./lib/stratum/server";
import { backfillRigTokens } from "./lib/backfill";
import { startDepositWorker } from "./lib/depositWorker";

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
  .then(() => {
    stratumServer.start();
    startDepositWorker();

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
