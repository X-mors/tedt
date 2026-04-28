import { Router, type IRouter, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import {
  db,
  cryptoDepositsTable,
  depositAddressesTable,
  usersTable,
  walletTransactionsTable,
  withdrawalsTable,
} from "@workspace/db";
import { verifyIpnSignature, type NpWebhookPayload } from "../lib/nowpayments";
import { cryptoToUsd } from "../lib/cryptoRates";
import { toUsdString, round6 } from "../lib/money";
import { logger } from "../lib/logger";
import { sql } from "drizzle-orm";
import { getWalletSettings } from "../lib/platformSettings";

const router: IRouter = Router();

function toCurrency(payCurrency: string): "btc" | "usdt_trc20" | null {
  const s = payCurrency.toLowerCase();
  if (s === "btc") return "btc";
  if (s === "usdttrc20" || s === "usdt_trc20" || s === "usdt") return "usdt_trc20";
  return null;
}

router.post(
  "/wallet/webhook/nowpayments",
  async (req: Request, res: Response) => {
    const rawBody: string =
      typeof req.body === "string"
        ? req.body
        : JSON.stringify(req.body);

    const sig = (req.headers["x-nowpayments-sig"] as string) ?? "";
    if (!verifyIpnSignature(rawBody, sig)) {
      logger.warn("NOWPayments IPN signature mismatch");
      res.status(401).json({ error: "Invalid signature" });
      return;
    }

    let payload: NpWebhookPayload;
    try {
      payload =
        typeof req.body === "string"
          ? (JSON.parse(req.body) as NpWebhookPayload)
          : (req.body as NpWebhookPayload);
    } catch {
      res.status(400).json({ error: "Invalid JSON" });
      return;
    }

    logger.info(
      { payment_id: payload.payment_id, status: payload.payment_status },
      "NOWPayments IPN received",
    );

    const currency = toCurrency(payload.pay_currency);
    if (!currency) {
      logger.warn({ pay_currency: payload.pay_currency }, "Unknown currency in IPN");
      res.json({ ok: true });
      return;
    }

    const orderId = payload.order_id ?? "";
    const paymentId = String(payload.payment_id);

    const existingDeposit = await db
      .select()
      .from(cryptoDepositsTable)
      .where(eq(cryptoDepositsTable.processorPaymentId, paymentId))
      .then((rows) => rows[0] ?? null);

    if (existingDeposit?.status === "credited") {
      res.json({ ok: true });
      return;
    }

    const depositAddress = await db
      .select()
      .from(depositAddressesTable)
      .where(eq(depositAddressesTable.processorPaymentId, paymentId))
      .then((rows) => rows[0] ?? null);

    let userId: number | null = depositAddress?.userId ?? null;

    if (!userId && orderId.startsWith("user-")) {
      const parsed = parseInt(orderId.replace("user-", "").split("-")[0] ?? "", 10);
      if (!isNaN(parsed)) userId = parsed;
    }

    const actuallyPaid = payload.actually_paid ?? 0;
    const npStatus = payload.payment_status;
    const walletSettings = await getWalletSettings();
    const requiredConf =
      currency === "btc"
        ? walletSettings.btcRequiredConfirmations
        : walletSettings.usdtTrc20RequiredConfirmations;

    const minDepositUsd =
      currency === "btc"
        ? walletSettings.btcMinDepositUsd
        : walletSettings.usdtTrc20MinDepositUsd;

    if (npStatus === "finished" && actuallyPaid > 0 && userId) {
      if (existingDeposit) {
        const depositStatus: string = existingDeposit.status;
        if (depositStatus === "credited") {
          res.json({ ok: true });
          return;
        }
        const amountUsd = await cryptoToUsd(actuallyPaid, currency);

        if (minDepositUsd > 0 && amountUsd < minDepositUsd) {
          logger.warn({ paymentId, amountUsd, minDepositUsd, currency }, "IPN deposit below minimum — not crediting");
          await db.update(cryptoDepositsTable).set({ status: "failed", lastCheckedAt: new Date() }).where(eq(cryptoDepositsTable.id, existingDeposit.id));
          res.json({ ok: true });
          return;
        }
        const rate = actuallyPaid > 0 ? amountUsd / actuallyPaid : 0;
        const amountUsdStr = toUsdString(amountUsd);

        await db.transaction(async (tx) => {
          const [updated] = await tx
            .update(cryptoDepositsTable)
            .set({
              status: "credited",
              amountCrypto: String(actuallyPaid),
              amountUsd: amountUsdStr,
              exchangeRate: toUsdString(rate),
              confirmations: requiredConf,
              creditedAt: new Date(),
              lastCheckedAt: new Date(),
            })
            .where(
              sql`${cryptoDepositsTable.id} = ${existingDeposit.id} AND ${cryptoDepositsTable.status} != 'credited'`,
            )
            .returning();

          if (!updated) return; // already credited by concurrent path

          const [credited] = await tx
            .update(usersTable)
            .set({
              balanceUsd: sql`${usersTable.balanceUsd} + ${amountUsdStr}`,
              totalDepositedUsd: sql`${usersTable.totalDepositedUsd} + ${amountUsdStr}`,
            })
            .where(eq(usersTable.id, userId!))
            .returning({ balanceUsd: usersTable.balanceUsd });

          if (!credited) throw new Error("User not found for deposit credit");

          await tx.insert(walletTransactionsTable).values({
            userId: userId!,
            type: "deposit",
            amountUsd: amountUsdStr,
            balanceAfterUsd: toUsdString(round6(Number(credited.balanceUsd))),
            memo: `${currency.toUpperCase()} deposit — ${actuallyPaid.toFixed(8)} ${currency === "btc" ? "BTC" : "USDT"} @ $${rate.toFixed(2)}`,
          });
        });

        logger.info({ userId, amountUsd: toUsdString(await cryptoToUsd(actuallyPaid, currency)), currency }, "Deposit credited via IPN");
      } else {
        const amountUsd = await cryptoToUsd(actuallyPaid, currency);

        if (minDepositUsd > 0 && amountUsd < minDepositUsd) {
          logger.warn({ paymentId, amountUsd, minDepositUsd, currency }, "IPN new deposit below minimum — not crediting");
          res.json({ ok: true });
          return;
        }

        const rate = actuallyPaid > 0 ? amountUsd / actuallyPaid : 0;
        const amountUsdStr = toUsdString(amountUsd);

        await db.transaction(async (tx) => {
          // INSERT ... RETURNING id is the correct way to detect if this
          // transaction won the race vs another concurrent path.
          const inserted = await tx
            .insert(cryptoDepositsTable)
            .values({
              userId: userId!,
              depositAddressId: depositAddress?.id ?? null,
              currency,
              amountCrypto: String(actuallyPaid),
              amountUsd: amountUsdStr,
              exchangeRate: toUsdString(rate),
              processorPaymentId: paymentId,
              status: "credited",
              confirmations: requiredConf,
              requiredConfirmations: requiredConf,
              creditedAt: new Date(),
              lastCheckedAt: new Date(),
            })
            .onConflictDoNothing({ target: cryptoDepositsTable.processorPaymentId })
            .returning({ id: cryptoDepositsTable.id });

          if (inserted.length === 0) {
            // Another path already inserted+credited this payment — skip.
            logger.info({ paymentId }, "IPN insert conflict — already handled");
            return;
          }

          const [credited] = await tx
            .update(usersTable)
            .set({
              balanceUsd: sql`${usersTable.balanceUsd} + ${amountUsdStr}`,
              totalDepositedUsd: sql`${usersTable.totalDepositedUsd} + ${amountUsdStr}`,
            })
            .where(eq(usersTable.id, userId!))
            .returning({ balanceUsd: usersTable.balanceUsd });

          if (!credited) throw new Error("User not found");

          await tx.insert(walletTransactionsTable).values({
            userId: userId!,
            type: "deposit",
            amountUsd: amountUsdStr,
            balanceAfterUsd: toUsdString(round6(Number(credited.balanceUsd))),
            memo: `${currency.toUpperCase()} deposit — ${actuallyPaid.toFixed(8)} ${currency === "btc" ? "BTC" : "USDT"} @ $${rate.toFixed(2)}`,
          });
        });

        logger.info({ userId, amountUsd, currency }, "New deposit created & credited via IPN");
      }
    } else if (
      (npStatus === "confirming" || npStatus === "sending") &&
      actuallyPaid > 0 &&
      userId
    ) {
      if (existingDeposit) {
        await db
          .update(cryptoDepositsTable)
          .set({ status: "confirming", lastCheckedAt: new Date() })
          .where(eq(cryptoDepositsTable.id, existingDeposit.id));
      } else {
        await db.insert(cryptoDepositsTable).values({
          userId: userId,
          depositAddressId: depositAddress?.id ?? null,
          currency,
          amountCrypto: String(actuallyPaid),
          processorPaymentId: paymentId,
          status: "confirming",
          confirmations: 0,
          requiredConfirmations: requiredConf,
          lastCheckedAt: new Date(),
        });
      }
    } else if (npStatus === "waiting" && userId && !existingDeposit) {
      await db.insert(cryptoDepositsTable).values({
        userId: userId,
        depositAddressId: depositAddress?.id ?? null,
        currency,
        amountCrypto: String(payload.pay_amount ?? 0),
        processorPaymentId: paymentId,
        status: "pending",
        confirmations: 0,
        requiredConfirmations: requiredConf,
        lastCheckedAt: new Date(),
      });
    } else if (
      !userId &&
      actuallyPaid > 0 &&
      npStatus === "finished"
    ) {
      logger.warn(
        { paymentId, orderId },
        "IPN received with no matching user — storing as unmatched",
      );
      await db
        .insert(cryptoDepositsTable)
        .values({
          userId: null,
          currency,
          amountCrypto: String(actuallyPaid),
          processorPaymentId: paymentId,
          status: "unmatched",
          confirmations: requiredConf,
          requiredConfirmations: requiredConf,
          creditedAt: new Date(),
          lastCheckedAt: new Date(),
          processorData: rawBody.slice(0, 4000),
        })
        .onConflictDoNothing({ target: cryptoDepositsTable.processorPaymentId });
    }

    res.json({ ok: true });
  },
);

// Payout (withdrawal) IPN — NOWPayments calls this when a payout status changes.
// extra_id is set to "withdrawal-{id}" when creating the payout.
router.post(
  "/wallet/webhook/nowpayments/payout",
  async (req: Request, res: Response) => {
    const rawBody: string =
      typeof req.body === "string" ? req.body : JSON.stringify(req.body);

    const sig = (req.headers["x-nowpayments-sig"] as string) ?? "";
    if (!verifyIpnSignature(rawBody, sig)) {
      logger.warn("NOWPayments payout IPN signature mismatch");
      res.status(401).json({ error: "Invalid signature" });
      return;
    }

    const body = (
      typeof req.body === "string" ? JSON.parse(req.body) : req.body
    ) as {
      id?: string;
      status?: string;
      extra_id?: string;
      hash?: string;
    };

    const payoutId = body.id ? String(body.id) : null;
    const status = body.status ?? "";
    const extraId = body.extra_id ?? "";
    const txid = body.hash ?? null;

    logger.info({ payoutId, status, extraId }, "NOWPayments payout IPN received");

    // extra_id format: "withdrawal-{id}"
    const withdrawalId = extraId.startsWith("withdrawal-")
      ? parseInt(extraId.replace("withdrawal-", ""), 10)
      : NaN;

    if (!isNaN(withdrawalId) && status === "FINISHED") {
      const [updated] = await db
        .update(withdrawalsTable)
        .set({
          status: "confirmed",
          onChainTxid: txid ?? undefined,
          decidedAt: new Date(),
        })
        .where(
          sql`${withdrawalsTable.id} = ${withdrawalId} AND ${withdrawalsTable.status} = 'sent'`,
        )
        .returning();

      if (updated) {
        logger.info({ withdrawalId, txid }, "Withdrawal confirmed via payout IPN");
      } else {
        logger.warn({ withdrawalId, status }, "Payout IPN: no matching sent withdrawal found");
      }
    }

    res.json({ ok: true });
  },
);

export default router;
