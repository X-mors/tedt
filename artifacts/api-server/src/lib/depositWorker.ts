import { eq, inArray, sql } from "drizzle-orm";
import {
  db,
  cryptoDepositsTable,
  usersTable,
  walletTransactionsTable,
} from "@workspace/db";
import { getPaymentStatus, nowpaymentsConfigured } from "./nowpayments";
import { cryptoToUsd } from "./cryptoRates";
import { getWalletSettings } from "./platformSettings";
import { logger } from "./logger";
import { toUsdString, round6 } from "./money";

const POLL_INTERVAL_MS = 60_000;

const NP_FINAL_STATUSES = new Set([
  "finished",
  "failed",
  "refunded",
  "expired",
  "partially_paid",
]);
const NP_CONFIRMING_STATUSES = new Set(["confirming", "sending", "confirmed"]);

async function getRequiredConfirmations(currency: string): Promise<number> {
  const settings = await getWalletSettings();
  if (currency === "btc") return settings.btcRequiredConfirmations;
  if (currency === "usdt_trc20") return settings.usdtTrc20RequiredConfirmations;
  return 1;
}

async function pollPendingDeposits() {
  if (!nowpaymentsConfigured()) return;

  const pending = await db
    .select()
    .from(cryptoDepositsTable)
    .where(
      inArray(cryptoDepositsTable.status, ["pending", "confirming"]),
    );

  if (pending.length === 0) return;
  logger.info({ count: pending.length }, "Polling pending crypto deposits");

  for (const deposit of pending) {
    if (!deposit.processorPaymentId) continue;
    try {
      const status = await getPaymentStatus(deposit.processorPaymentId);
      const npStatus = status.payment_status;

      const actuallyPaid = status.actually_paid ?? 0;

      // NOWPayments returns confirmations in the `payin_extra_id` for some
      // currencies, but most reliably in `network_precision` as a string like "2/3".
      // Parse "X/Y" format or use plain number.
      let confirmations = deposit.confirmations;
      if (status.network_precision != null) {
        const raw = String(status.network_precision);
        const slashIdx = raw.indexOf("/");
        const parsed = slashIdx >= 0
          ? parseInt(raw.slice(0, slashIdx), 10)
          : parseInt(raw, 10);
        if (Number.isFinite(parsed)) confirmations = parsed;
      }

      // on-chain txid — NOWPayments puts this in payin_hash or payin_extra_id for some chains
      const statusAny = status as unknown as Record<string, unknown>;
      const onChainTxid = (statusAny["payin_hash"] as string | undefined)
        ?? (statusAny["payin_extra_id"] as string | undefined)
        ?? null;

      const requiredConf = await getRequiredConfirmations(deposit.currency);

      if (npStatus === "finished") {
        if (deposit.status === "credited") continue;
        if (!deposit.userId) continue; // unmatched — skip worker crediting

        const amountCrypto = actuallyPaid > 0 ? actuallyPaid : Number(deposit.amountCrypto);
        const amountUsd = await cryptoToUsd(amountCrypto, deposit.currency as "btc" | "usdt_trc20");
        const rate = amountCrypto > 0 ? amountUsd / amountCrypto : 0;

        await db.transaction(async (tx) => {
          const [updated] = await tx
            .update(cryptoDepositsTable)
            .set({
              status: "credited",
              amountCrypto: String(amountCrypto),
              amountUsd: toUsdString(amountUsd),
              exchangeRate: toUsdString(rate),
              confirmations: requiredConf,
              txid: onChainTxid ?? deposit.txid,
              creditedAt: new Date(),
              lastCheckedAt: new Date(),
            })
            .where(
              sql`${cryptoDepositsTable.id} = ${deposit.id} AND ${cryptoDepositsTable.status} != 'credited'`,
            )
            .returning();

          if (!updated) return; // already credited by concurrent IPN webhook

          const amountUsdStr = toUsdString(amountUsd);
          const [credited] = await tx
            .update(usersTable)
            .set({
              balanceUsd: sql`${usersTable.balanceUsd} + ${amountUsdStr}`,
              totalDepositedUsd: sql`${usersTable.totalDepositedUsd} + ${amountUsdStr}`,
            })
            .where(eq(usersTable.id, deposit.userId!))
            .returning({ balanceUsd: usersTable.balanceUsd });

          if (!credited) throw new Error("Failed to credit user");

          await tx.insert(walletTransactionsTable).values({
            userId: deposit.userId!,
            type: "deposit",
            amountUsd: amountUsdStr,
            balanceAfterUsd: toUsdString(round6(Number(credited.balanceUsd))),
            memo: `${deposit.currency.toUpperCase()} deposit — ${amountCrypto.toFixed(8)} ${deposit.currency === "btc" ? "BTC" : "USDT"} @ $${rate.toFixed(2)}`,
          });
        });
        logger.info(
          { depositId: deposit.id, amountUsd, userId: deposit.userId },
          "Deposit credited to user",
        );
      } else if (NP_CONFIRMING_STATUSES.has(npStatus)) {
        await db
          .update(cryptoDepositsTable)
          .set({
            status: "confirming",
            confirmations,
            txid: onChainTxid ?? deposit.txid,
            lastCheckedAt: new Date(),
          })
          .where(eq(cryptoDepositsTable.id, deposit.id));
      } else if (NP_FINAL_STATUSES.has(npStatus) && npStatus !== "finished") {
        await db
          .update(cryptoDepositsTable)
          .set({ status: "failed", lastCheckedAt: new Date() })
          .where(eq(cryptoDepositsTable.id, deposit.id));
        logger.warn(
          { depositId: deposit.id, npStatus },
          "Deposit marked failed by processor",
        );
      } else {
        await db
          .update(cryptoDepositsTable)
          .set({ lastCheckedAt: new Date() })
          .where(eq(cryptoDepositsTable.id, deposit.id));
      }
    } catch (err) {
      logger.error({ err, depositId: deposit.id }, "Error polling deposit status");
    }
  }
}

let workerTimer: ReturnType<typeof setTimeout> | null = null;

async function workerLoop() {
  try {
    await pollPendingDeposits();
  } catch (err) {
    logger.error({ err }, "Deposit worker loop error");
  } finally {
    workerTimer = setTimeout(workerLoop, POLL_INTERVAL_MS);
  }
}

export function startDepositWorker() {
  if (workerTimer) return;
  logger.info("Starting deposit worker");
  workerTimer = setTimeout(workerLoop, POLL_INTERVAL_MS);
}

export function stopDepositWorker() {
  if (workerTimer) {
    clearTimeout(workerTimer);
    workerTimer = null;
  }
}
