import { Router, type IRouter } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  walletTransactionsTable,
  withdrawalsTable,
  depositAddressesTable,
  cryptoDepositsTable,
} from "@workspace/db";
import {
  CreateWithdrawalBody,
  GetMyWalletResponse,
  ListMyWithdrawalsResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../lib/auth";
import { round6, toNum, toUsdString } from "../lib/money";
import {
  createDepositPayment,
  nowpaymentsConfigured,
} from "../lib/nowpayments";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.use(requireAuth);

router.get("/me/wallet", async (req, res) => {
  const txns = await db
    .select()
    .from(walletTransactionsTable)
    .where(eq(walletTransactionsTable.userId, req.currentUser!.id))
    .orderBy(desc(walletTransactionsTable.createdAt))
    .limit(100);

  const [pending] = await db
    .select({
      sum: sql<string>`COALESCE(SUM(${withdrawalsTable.amountUsd}), 0)`,
    })
    .from(withdrawalsTable)
    .where(
      and(
        eq(withdrawalsTable.userId, req.currentUser!.id),
        eq(withdrawalsTable.status, "pending"),
      ),
    );

  const data = GetMyWalletResponse.parse({
    balanceUsd: toNum(req.currentUser!.balanceUsd),
    pendingWithdrawalsUsd: toNum(pending?.sum),
    totalDepositedUsd: toNum(req.currentUser!.totalDepositedUsd),
    totalEarnedUsd: toNum(req.currentUser!.totalEarnedUsd),
    totalSpentUsd: toNum(req.currentUser!.totalSpentUsd),
    transactions: txns.map((t) => ({
      id: t.id,
      type: t.type,
      amountUsd: toNum(t.amountUsd),
      balanceAfterUsd: toNum(t.balanceAfterUsd),
      memo: t.memo,
      relatedRentalId: t.relatedRentalId,
      createdAt: t.createdAt.toISOString(),
    })),
  });
  res.json(data);
});

const ADDRESS_VALIDITY_MS = 365 * 24 * 60 * 60 * 1000;

router.get(
  "/me/wallet/deposit-addresses",
  async (req, res) => {
    const userId = req.currentUser!.id;
    const currencies: Array<"btc" | "usdt_trc20"> = ["btc", "usdt_trc20"];

    const result: Record<
      string,
      {
        currency: string;
        address: string;
        processorPaymentId: string | null;
        expiresAt: string | null;
        minDepositUsd: number;
        requiredConfirmations: number;
        network: string;
        ready: boolean;
      }
    > = {};

    for (const currency of currencies) {
      const now = new Date();
      const existing = await db
        .select()
        .from(depositAddressesTable)
        .where(
          and(
            eq(depositAddressesTable.userId, userId),
            eq(depositAddressesTable.currency, currency),
          ),
        )
        .orderBy(desc(depositAddressesTable.createdAt))
        .limit(1)
        .then((rows) => rows[0] ?? null);

      if (existing && (!existing.expiresAt || existing.expiresAt > now)) {
        result[currency] = {
          currency,
          address: existing.address,
          processorPaymentId: existing.processorPaymentId,
          expiresAt: existing.expiresAt
            ? existing.expiresAt.toISOString()
            : null,
          minDepositUsd: currency === "btc" ? 10 : 5,
          requiredConfirmations: currency === "btc" ? 2 : 20,
          network: currency === "btc" ? "Bitcoin" : "TRON (TRC-20)",
          ready: true,
        };
        continue;
      }

      if (!nowpaymentsConfigured()) {
        result[currency] = {
          currency,
          address: "",
          processorPaymentId: null,
          expiresAt: null,
          minDepositUsd: currency === "btc" ? 10 : 5,
          requiredConfirmations: currency === "btc" ? 2 : 20,
          network: currency === "btc" ? "Bitcoin" : "TRON (TRC-20)",
          ready: false,
        };
        continue;
      }

      try {
        const orderId = `user-${userId}-${currency}-${Date.now()}`;
        const payment = await createDepositPayment(currency, orderId);
        const expiresAt = new Date(Date.now() + ADDRESS_VALIDITY_MS);

        const [row] = await db
          .insert(depositAddressesTable)
          .values({
            userId,
            currency,
            address: payment.pay_address,
            processorPaymentId: payment.payment_id,
            expiresAt,
          })
          .returning();

        result[currency] = {
          currency,
          address: row!.address,
          processorPaymentId: row!.processorPaymentId,
          expiresAt: row!.expiresAt ? row!.expiresAt.toISOString() : null,
          minDepositUsd: currency === "btc" ? 10 : 5,
          requiredConfirmations: currency === "btc" ? 2 : 20,
          network: currency === "btc" ? "Bitcoin" : "TRON (TRC-20)",
          ready: true,
        };
      } catch (err) {
        logger.error({ err, currency, userId }, "Failed to create deposit address");
        result[currency] = {
          currency,
          address: "",
          processorPaymentId: null,
          expiresAt: null,
          minDepositUsd: currency === "btc" ? 10 : 5,
          requiredConfirmations: currency === "btc" ? 2 : 20,
          network: currency === "btc" ? "Bitcoin" : "TRON (TRC-20)",
          ready: false,
        };
      }
    }

    res.json({ addresses: Object.values(result), processorConfigured: nowpaymentsConfigured() });
  },
);

router.get("/me/wallet/deposits", async (req, res) => {
  const userId = req.currentUser!.id;
  const deposits = await db
    .select()
    .from(cryptoDepositsTable)
    .where(eq(cryptoDepositsTable.userId, userId))
    .orderBy(desc(cryptoDepositsTable.detectedAt))
    .limit(50);

  res.json(
    deposits.map((d) => ({
      id: d.id,
      currency: d.currency,
      amountCrypto: d.amountCrypto,
      amountUsd: d.amountUsd ? toNum(d.amountUsd) : null,
      exchangeRate: d.exchangeRate ? toNum(d.exchangeRate) : null,
      txid: d.txid,
      status: d.status,
      confirmations: d.confirmations,
      requiredConfirmations: d.requiredConfirmations,
      detectedAt: d.detectedAt.toISOString(),
      creditedAt: d.creditedAt ? d.creditedAt.toISOString() : null,
    })),
  );
});

router.post("/me/wallet/deposits", async (_req, res) => {
  res.status(410).json({
    error: "ENDPOINT_CHANGED",
    message:
      "Use GET /me/wallet/deposit-addresses to fetch your dedicated deposit addresses.",
  });
});

router.get("/me/wallet/withdrawals", async (req, res) => {
  const rows = await db
    .select()
    .from(withdrawalsTable)
    .where(eq(withdrawalsTable.userId, req.currentUser!.id))
    .orderBy(desc(withdrawalsTable.createdAt));

  const data = ListMyWithdrawalsResponse.parse(
    rows.map((w) => ({
      id: w.id,
      userId: w.userId,
      asset: w.asset,
      destinationAddress: w.destinationAddress,
      amountUsd: toNum(w.amountUsd),
      status: w.status,
      adminNote: w.adminNote,
      onChainTxid: w.onChainTxid ?? null,
      createdAt: w.createdAt.toISOString(),
      decidedAt: w.decidedAt ? w.decidedAt.toISOString() : null,
      sentAt: w.sentAt ? w.sentAt.toISOString() : null,
    })),
  );
  res.json(data);
});

router.post("/me/wallet/withdrawals", async (req, res) => {
  const body = CreateWithdrawalBody.parse(req.body);
  const amountStr = toUsdString(body.amountUsd);

  class TxError extends Error {
    constructor(public readonly code: "insufficient" | "insert") {
      super(code);
      this.name = "TxError";
    }
  }

  let withdrawalRow: typeof withdrawalsTable.$inferSelect;
  try {
    withdrawalRow = await db.transaction(async (tx) => {
      const [debited] = await tx
        .update(usersTable)
        .set({ balanceUsd: sql`${usersTable.balanceUsd} - ${amountStr}` })
        .where(
          and(
            eq(usersTable.id, req.currentUser!.id),
            sql`${usersTable.balanceUsd} >= ${amountStr}`,
          ),
        )
        .returning({ balanceUsd: usersTable.balanceUsd });
      if (!debited) throw new TxError("insufficient");

      const newBalance = round6(toNum(debited.balanceUsd));
      const [row] = await tx
        .insert(withdrawalsTable)
        .values({
          userId: req.currentUser!.id,
          asset: body.asset,
          destinationAddress: body.destinationAddress,
          amountUsd: amountStr,
        })
        .returning();
      if (!row) throw new TxError("insert");

      await tx.insert(walletTransactionsTable).values({
        userId: req.currentUser!.id,
        type: "withdrawal",
        amountUsd: toUsdString(-body.amountUsd),
        balanceAfterUsd: toUsdString(newBalance),
        memo: `Withdrawal request #${row.id} (${body.asset})`,
      });
      return row;
    });
  } catch (err) {
    if (err instanceof TxError) {
      if (err.code === "insufficient") {
        res.status(402).json({ error: "Insufficient balance for withdrawal." });
      } else {
        res.status(500).json({ error: "Failed to create withdrawal" });
      }
      return;
    }
    throw err;
  }

  const w = withdrawalRow;
  res.status(201).json({
    id: w.id,
    userId: w.userId,
    asset: w.asset,
    destinationAddress: w.destinationAddress,
    amountUsd: toNum(w.amountUsd),
    status: w.status,
    adminNote: w.adminNote,
    onChainTxid: w.onChainTxid ?? null,
    createdAt: w.createdAt.toISOString(),
    decidedAt: w.decidedAt ? w.decidedAt.toISOString() : null,
    sentAt: w.sentAt ? w.sentAt.toISOString() : null,
  });
});

export default router;
