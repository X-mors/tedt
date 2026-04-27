import { Router, type IRouter } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  walletTransactionsTable,
  withdrawalsTable,
} from "@workspace/db";
import {
  CreateDepositBody,
  CreateWithdrawalBody,
  GetMyWalletResponse,
  ListMyWithdrawalsResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../lib/auth";
import { round6, toNum, toUsdString } from "../lib/money";
import { randomBytes } from "node:crypto";

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

router.post("/me/wallet/deposits", async (req, res) => {
  const body = CreateDepositBody.parse(req.body);
  // Generate a deterministic-looking address per request — production would
  // call a real wallet service. The site operator monitors incoming funds
  // and credits the user via the admin panel.
  const tag = randomBytes(20).toString("hex");
  const address =
    body.asset === "BTC"
      ? `bc1q${tag.slice(0, 38)}`
      : `T${tag.slice(0, 33)}`;
  const memo = `RM-${req.currentUser!.id}-${randomBytes(4).toString("hex")}`;

  res.status(201).json({
    asset: body.asset,
    depositAddress: address,
    memo,
    amountUsd: body.amountUsd,
    note:
      body.asset === "BTC"
        ? "Send BTC to the address above. Funds will appear after 1 on-chain confirmation."
        : "Send USDT (TRC-20) to the address above. Include the memo if your wallet supports it.",
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

  // Atomic conditional debit — only succeeds if the user actually has the
  // funds at the moment the UPDATE runs, avoiding stale-snapshot races.
  const result = await db.transaction(async (tx) => {
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
    if (!debited) return { error: "insufficient" as const };

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
    if (!row) return { error: "insert" as const };

    await tx.insert(walletTransactionsTable).values({
      userId: req.currentUser!.id,
      type: "withdrawal",
      amountUsd: toUsdString(-body.amountUsd),
      balanceAfterUsd: toUsdString(newBalance),
      memo: `Withdrawal request #${row.id} (${body.asset})`,
    });
    return { row };
  });

  if ("error" in result) {
    if (result.error === "insufficient") {
      res.status(402).json({ error: "Insufficient balance for withdrawal." });
    } else {
      res.status(500).json({ error: "Failed to create withdrawal" });
    }
    return;
  }

  const w = result.row;
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
