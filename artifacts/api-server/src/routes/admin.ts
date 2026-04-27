import { Router, type IRouter } from "express";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  algorithmsTable,
  rigsTable,
  rentalsTable,
  walletTransactionsTable,
  withdrawalsTable,
  commissionConfigTable,
} from "@workspace/db";
import {
  AdminCreditWalletBody,
  AdminCreditWalletResponse,
  ApproveWithdrawalBody,
  ApproveWithdrawalResponse,
  CreateAlgorithmBody,
  GetAdminStatsResponse,
  GetCommissionConfigResponse,
  ListAdminUsersResponse,
  ListAdminWithdrawalsResponse,
  RejectWithdrawalBody,
  RejectWithdrawalResponse,
  UpdateAlgorithmBody,
  UpdateAlgorithmResponse,
  UpdateCommissionConfigBody,
  UpdateCommissionConfigResponse,
} from "@workspace/api-zod";
import { requireAdmin } from "../lib/auth";
import { round6, toNum, toUsdString } from "../lib/money";
import { getCommission } from "../lib/commission";

const router: IRouter = Router();

router.use(requireAdmin);

router.get("/admin/stats", async (_req, res) => {
  const [users] = await db
    .select({ c: sql<string>`COUNT(*)` })
    .from(usersTable);
  const [rigs] = await db
    .select({
      total: sql<string>`COUNT(*)`,
      avail: sql<string>`COUNT(*) FILTER (WHERE ${rigsTable.status} = 'available')`,
      rented: sql<string>`COUNT(*) FILTER (WHERE ${rigsTable.status} = 'rented')`,
    })
    .from(rigsTable);
  const [rentals] = await db
    .select({
      active: sql<string>`COUNT(*) FILTER (WHERE ${rentalsTable.status} = 'active')`,
      completed: sql<string>`COUNT(*) FILTER (WHERE ${rentalsTable.status} = 'completed')`,
      revenue: sql<string>`COALESCE(SUM(${rentalsTable.platformFeeUsd}), 0)`,
      volume: sql<string>`COALESCE(SUM(${rentalsTable.renterTotalUsd}), 0)`,
    })
    .from(rentalsTable);

  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const [last24] = await db
    .select({
      vol: sql<string>`COALESCE(SUM(${rentalsTable.renterTotalUsd}), 0)`,
      cnt: sql<string>`COUNT(*)`,
    })
    .from(rentalsTable)
    .where(gte(rentalsTable.createdAt, since));

  const [pending] = await db
    .select({
      sum: sql<string>`COALESCE(SUM(${withdrawalsTable.amountUsd}), 0)`,
    })
    .from(withdrawalsTable)
    .where(eq(withdrawalsTable.status, "pending"));

  const data = GetAdminStatsResponse.parse({
    totalUsers: Number(users?.c ?? 0),
    totalRigs: Number(rigs?.total ?? 0),
    availableRigs: Number(rigs?.avail ?? 0),
    rentedRigs: Number(rigs?.rented ?? 0),
    activeRentals: Number(rentals?.active ?? 0),
    completedRentals: Number(rentals?.completed ?? 0),
    platformRevenueUsd: toNum(rentals?.revenue),
    totalRentalVolumeUsd: toNum(rentals?.volume),
    pendingWithdrawalsUsd: toNum(pending?.sum),
    last24hRentalsUsd: toNum(last24?.vol),
    last24hRentalCount: Number(last24?.cnt ?? 0),
  });
  res.json(data);
});

router.get("/admin/users", async (_req, res) => {
  const rows = await db
    .select({
      id: usersTable.id,
      clerkUserId: usersTable.clerkUserId,
      email: usersTable.email,
      displayName: usersTable.displayName,
      role: usersTable.role,
      balanceUsd: usersTable.balanceUsd,
      totalDepositedUsd: usersTable.totalDepositedUsd,
      totalEarnedUsd: usersTable.totalEarnedUsd,
      totalSpentUsd: usersTable.totalSpentUsd,
      createdAt: usersTable.createdAt,
      rigCount: sql<string>`(SELECT COUNT(*) FROM rigs WHERE owner_id = ${usersTable.id})`,
      rentalCount: sql<string>`(SELECT COUNT(*) FROM rentals WHERE renter_id = ${usersTable.id})`,
    })
    .from(usersTable)
    .orderBy(desc(usersTable.createdAt));

  const data = ListAdminUsersResponse.parse(
    rows.map((r) => ({
      id: r.id,
      clerkUserId: r.clerkUserId,
      email: r.email,
      displayName: r.displayName,
      role: r.role,
      balanceUsd: toNum(r.balanceUsd),
      totalDepositedUsd: toNum(r.totalDepositedUsd),
      totalEarnedUsd: toNum(r.totalEarnedUsd),
      totalSpentUsd: toNum(r.totalSpentUsd),
      rigCount: Number(r.rigCount),
      rentalCount: Number(r.rentalCount),
      createdAt: r.createdAt.toISOString(),
    })),
  );
  res.json(data);
});

router.post("/admin/wallet/credit", async (req, res) => {
  const body = AdminCreditWalletBody.parse(req.body);
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, body.userId));
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const newBalance = round6(toNum(user.balanceUsd) + body.amountUsd);
  if (newBalance < 0) {
    res.status(400).json({ error: "Adjustment would create negative balance" });
    return;
  }
  const isCredit = body.amountUsd >= 0;
  const newDeposited = isCredit
    ? round6(toNum(user.totalDepositedUsd) + body.amountUsd)
    : toNum(user.totalDepositedUsd);

  await db.transaction(async (tx) => {
    await tx
      .update(usersTable)
      .set({
        balanceUsd: toUsdString(newBalance),
        totalDepositedUsd: toUsdString(newDeposited),
      })
      .where(eq(usersTable.id, user.id));
    await tx.insert(walletTransactionsTable).values({
      userId: user.id,
      type: isCredit ? "admin_credit" : "admin_debit",
      amountUsd: toUsdString(body.amountUsd),
      balanceAfterUsd: toUsdString(newBalance),
      memo: body.memo,
    });
  });

  const data = AdminCreditWalletResponse.parse({
    userId: user.id,
    newBalanceUsd: newBalance,
  });
  res.json(data);
});

router.get("/admin/commission", async (_req, res) => {
  const c = await getCommission();
  const [row] = await db.select().from(commissionConfigTable).limit(1);
  const data = GetCommissionConfigResponse.parse({
    renterFeePct: c.renterFeePct,
    ownerFeePct: c.ownerFeePct,
    updatedAt: (row?.updatedAt ?? new Date()).toISOString(),
  });
  res.json(data);
});

router.patch("/admin/commission", async (req, res) => {
  const body = UpdateCommissionConfigBody.parse(req.body);
  const [existing] = await db.select().from(commissionConfigTable).limit(1);
  if (!existing) {
    await db.insert(commissionConfigTable).values({
      renterFeePct: (body.renterFeePct ?? 3).toString(),
      ownerFeePct: (body.ownerFeePct ?? 5).toString(),
    });
  } else {
    const patch: Record<string, unknown> = {};
    if (body.renterFeePct !== undefined)
      patch["renterFeePct"] = body.renterFeePct.toString();
    if (body.ownerFeePct !== undefined)
      patch["ownerFeePct"] = body.ownerFeePct.toString();
    if (Object.keys(patch).length > 0) {
      await db
        .update(commissionConfigTable)
        .set(patch)
        .where(eq(commissionConfigTable.id, existing.id));
    }
  }
  const c = await getCommission();
  const [row] = await db.select().from(commissionConfigTable).limit(1);
  const data = UpdateCommissionConfigResponse.parse({
    renterFeePct: c.renterFeePct,
    ownerFeePct: c.ownerFeePct,
    updatedAt: (row?.updatedAt ?? new Date()).toISOString(),
  });
  res.json(data);
});

router.post("/admin/algorithms", async (req, res) => {
  const body = CreateAlgorithmBody.parse(req.body);
  const [created] = await db
    .insert(algorithmsTable)
    .values({
      name: body.name,
      slug: body.slug,
      unit: body.unit,
      basePricePerUnitPerHour: body.basePricePerUnitPerHour.toString(),
    })
    .returning();
  res.status(201).json({
    id: created!.id,
    name: created!.name,
    slug: created!.slug,
    unit: created!.unit,
    basePricePerUnitPerHour: toNum(created!.basePricePerUnitPerHour),
    rigCount: 0,
    totalHashrate: 0,
    averagePricePerUnitPerHour: toNum(created!.basePricePerUnitPerHour),
  });
});

router.patch("/admin/algorithms/:id", async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const body = UpdateAlgorithmBody.parse(req.body);
  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) patch["name"] = body.name;
  if (body.unit !== undefined) patch["unit"] = body.unit;
  if (body.basePricePerUnitPerHour !== undefined)
    patch["basePricePerUnitPerHour"] = body.basePricePerUnitPerHour.toString();
  await db.update(algorithmsTable).set(patch).where(eq(algorithmsTable.id, id));
  const [updated] = await db
    .select()
    .from(algorithmsTable)
    .where(eq(algorithmsTable.id, id));
  if (!updated) {
    res.status(404).json({ error: "Algorithm not found" });
    return;
  }
  const c = await getCommission();
  const data = UpdateAlgorithmResponse.parse({
    id: updated.id,
    name: updated.name,
    slug: updated.slug,
    unit: updated.unit,
    basePricePerUnitPerHour: toNum(updated.basePricePerUnitPerHour),
    rigCount: 0,
    totalHashrate: 0,
    averagePricePerUnitPerHour:
      toNum(updated.basePricePerUnitPerHour) * (1 + c.renterFeePct / 100),
  });
  res.json(data);
});

router.delete("/admin/algorithms/:id", async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [inUse] = await db
    .select({ c: sql<string>`COUNT(*)` })
    .from(rigsTable)
    .where(eq(rigsTable.algorithmId, id));
  if (Number(inUse?.c ?? 0) > 0) {
    res.status(400).json({ error: "Algorithm is in use by one or more rigs" });
    return;
  }
  await db.delete(algorithmsTable).where(eq(algorithmsTable.id, id));
  res.status(204).end();
});

router.get("/admin/withdrawals", async (_req, res) => {
  const rows = await db
    .select({
      id: withdrawalsTable.id,
      userId: withdrawalsTable.userId,
      userEmail: usersTable.email,
      userDisplayName: usersTable.displayName,
      asset: withdrawalsTable.asset,
      destinationAddress: withdrawalsTable.destinationAddress,
      amountUsd: withdrawalsTable.amountUsd,
      status: withdrawalsTable.status,
      createdAt: withdrawalsTable.createdAt,
    })
    .from(withdrawalsTable)
    .innerJoin(usersTable, eq(usersTable.id, withdrawalsTable.userId))
    .orderBy(desc(withdrawalsTable.createdAt));

  const data = ListAdminWithdrawalsResponse.parse(
    rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      userEmail: r.userEmail,
      userDisplayName: r.userDisplayName,
      asset: r.asset,
      destinationAddress: r.destinationAddress,
      amountUsd: toNum(r.amountUsd),
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    })),
  );
  res.json(data);
});

router.post("/admin/withdrawals/:id/approve", async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const body = ApproveWithdrawalBody.parse(req.body);
  const [row] = await db
    .select()
    .from(withdrawalsTable)
    .where(eq(withdrawalsTable.id, id));
  if (!row) {
    res.status(404).json({ error: "Withdrawal not found" });
    return;
  }
  if (row.status !== "pending") {
    res.status(400).json({ error: "Withdrawal already decided" });
    return;
  }
  const [updated] = await db
    .update(withdrawalsTable)
    .set({
      status: "approved",
      adminNote: body.adminNote ?? null,
      decidedAt: new Date(),
    })
    .where(eq(withdrawalsTable.id, id))
    .returning();

  const data = ApproveWithdrawalResponse.parse({
    id: updated!.id,
    userId: updated!.userId,
    asset: updated!.asset,
    destinationAddress: updated!.destinationAddress,
    amountUsd: toNum(updated!.amountUsd),
    status: updated!.status,
    adminNote: updated!.adminNote,
    createdAt: updated!.createdAt.toISOString(),
    decidedAt: updated!.decidedAt ? updated!.decidedAt.toISOString() : null,
  });
  res.json(data);
});

router.post("/admin/withdrawals/:id/reject", async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const body = RejectWithdrawalBody.parse(req.body);
  const [row] = await db
    .select()
    .from(withdrawalsTable)
    .where(eq(withdrawalsTable.id, id));
  if (!row) {
    res.status(404).json({ error: "Withdrawal not found" });
    return;
  }
  if (row.status !== "pending") {
    res.status(400).json({ error: "Withdrawal already decided" });
    return;
  }
  // Refund the held funds to the user.
  const result = await db.transaction(async (tx) => {
    const [user] = await tx
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, row.userId));
    if (!user) throw new Error("User missing");
    const refund = toNum(row.amountUsd);
    const newBalance = round6(toNum(user.balanceUsd) + refund);
    await tx
      .update(usersTable)
      .set({ balanceUsd: toUsdString(newBalance) })
      .where(eq(usersTable.id, user.id));
    await tx.insert(walletTransactionsTable).values({
      userId: user.id,
      type: "admin_credit",
      amountUsd: toUsdString(refund),
      balanceAfterUsd: toUsdString(newBalance),
      memo: `Refund for rejected withdrawal #${row.id}`,
    });
    const [updated] = await tx
      .update(withdrawalsTable)
      .set({
        status: "rejected",
        adminNote: body.adminNote ?? null,
        decidedAt: new Date(),
      })
      .where(eq(withdrawalsTable.id, id))
      .returning();
    return updated!;
  });

  const data = RejectWithdrawalResponse.parse({
    id: result.id,
    userId: result.userId,
    asset: result.asset,
    destinationAddress: result.destinationAddress,
    amountUsd: toNum(result.amountUsd),
    status: result.status,
    adminNote: result.adminNote,
    createdAt: result.createdAt.toISOString(),
    decidedAt: result.decidedAt ? result.decidedAt.toISOString() : null,
  });
  res.json(data);
});

void and;

export default router;
