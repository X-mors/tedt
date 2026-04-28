import { Router, type IRouter } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  walletTransactionsTable,
  withdrawalsTable,
} from "@workspace/db";
import {
  CreateWithdrawalBody,
  GetMyWalletResponse,
  ListMyWithdrawalsResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../lib/auth";
import { round6, toNum, toUsdString } from "../lib/money";

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

router.post("/me/wallet/deposits", async (_req, res) => {
  // Crypto deposit rails are not yet active (Task #3).
  // Return 503 with a clear message so no client code can accidentally
  // treat this as a real deposit flow.
  res.status(503).json({
    error: "DEPOSITS_NOT_YET_ACTIVE",
    message:
      "On-chain BTC and USDT deposits are not yet available. Contact support to have your balance credited manually.",
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
      createdAt: w.createdAt.toISOString(),
      decidedAt: w.decidedAt ? w.decidedAt.toISOString() : null,
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
    // Atomic conditional debit — only succeeds if the user actually has the
    // funds at the moment the UPDATE runs, avoiding stale-snapshot races.
    // Throwing inside the callback guarantees Drizzle rolls back on any failure.
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
    createdAt: w.createdAt.toISOString(),
    decidedAt: w.decidedAt ? w.decidedAt.toISOString() : null,
  });
});

export default router;
