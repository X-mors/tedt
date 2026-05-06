import { Router, type IRouter } from "express";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  algorithmsTable,
  rigsTable,
  rentalsTable,
  walletTransactionsTable,
  withdrawalsTable,
  commissionConfigTable,
  cryptoDepositsTable,
} from "@workspace/db";
import { proxyState } from "../lib/stratum/state";
import {
  getProxySettings,
  getWalletSettings,
  setProxySetting,
  setWalletSetting,
  proxySettingsDefaults,
  walletSettingsDefaults,
} from "../lib/platformSettings";
import {
  createPayout,
  nowpaymentsConfigured,
  type NpCurrency,
} from "../lib/nowpayments";
import { usdToCrypto } from "../lib/cryptoRates";
import {
  AdminCreditWalletBody,
  AdminCreditWalletResponse,
  ApproveRigBody,
  ApproveRigResponse,
  ApproveWithdrawalBody,
  SetAdminRigStatusBody,
  SetAdminRigStatusResponse,
  ApproveWithdrawalResponse,
  CreateAlgorithmBody,
  GetAdminStatsResponse,
  GetAdminSummaryResponse,
  GetCommissionConfigResponse,
  ListAdminRentalsResponse,
  ListAdminRigsQueryParams,
  ListAdminRigsResponse,
  ListAdminUsersResponse,
  ListAdminWalletTransactionsQueryParams,
  ListAdminWalletTransactionsResponse,
  ListAdminWithdrawalsResponse,
  RejectRigBody,
  RejectRigResponse,
  RejectWithdrawalBody,
  RejectWithdrawalResponse,
  ResolveRentalDisputeBody,
  ResolveRentalDisputeResponse,
  UpdateAlgorithmBody,
  UpdateAlgorithmResponse,
  UpdateCommissionConfigBody,
  UpdateCommissionConfigResponse,
} from "@workspace/api-zod";
import { requireAdmin } from "../lib/auth";
import { round6, toNum, toUsdString, computeDeliveryRatio } from "../lib/money";
import { getCommission } from "../lib/commission";
import { settleExpiredRentals } from "../lib/settlement";

const router: IRouter = Router();

router.use(requireAdmin);

router.get("/admin/summary", async (_req, res) => {
  const today = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [users] = await db.select({ c: sql<string>`COUNT(*)` }).from(usersTable);
  const [activeRentals] = await db
    .select({ c: sql<string>`COUNT(*) FILTER (WHERE ${rentalsTable.status} = 'active')` })
    .from(rentalsTable);
  const [pendingRigApprovals] = await db
    .select({ c: sql<string>`COUNT(*) FILTER (WHERE ${rigsTable.approvalStatus} = 'pending')` })
    .from(rigsTable);
  const [pendingWithdrawals] = await db
    .select({ c: sql<string>`COUNT(*) FILTER (WHERE ${withdrawalsTable.status} = 'pending')` })
    .from(withdrawalsTable);

  const [revenue] = await db
    .select({
      revenueTodayUsd: sql<string>`COALESCE(SUM(${rentalsTable.renterTotalUsd}) FILTER (WHERE ${rentalsTable.createdAt} >= ${today.toISOString()}), 0)`,
      commissionTodayUsd: sql<string>`COALESCE(SUM(${rentalsTable.platformFeeUsd}) FILTER (WHERE ${rentalsTable.createdAt} >= ${today.toISOString()}), 0)`,
    })
    .from(rentalsTable);

  const [hashrate] = await db
    .select({
      currentlyRentedHashrate: sql<string>`COALESCE(SUM(${rigsTable.hashrate}) FILTER (WHERE ${rigsTable.status} = 'rented' AND ${rigsTable.approvalStatus} = 'approved'), 0)`,
    })
    .from(rigsTable);

  const data = GetAdminSummaryResponse.parse({
    totalUsers: Number(users?.c ?? 0),
    activeRentals: Number(activeRentals?.c ?? 0),
    pendingRigApprovals: Number(pendingRigApprovals?.c ?? 0),
    pendingWithdrawals: Number(pendingWithdrawals?.c ?? 0),
    revenueTodayUsd: toNum(revenue?.revenueTodayUsd ?? "0"),
    commissionTodayUsd: toNum(revenue?.commissionTodayUsd ?? "0"),
    currentlyRentedHashrate: toNum(hashrate?.currentlyRentedHashrate ?? "0"),
  });

  res.json(data);
});

router.get("/admin/stats", async (_req, res) => {
  await settleExpiredRentals();

  const [users] = await db
    .select({ c: sql<string>`COUNT(*)` })
    .from(usersTable);
  const [rigs] = await db
    .select({
      total: sql<string>`COUNT(*)`,
      avail: sql<string>`COUNT(*) FILTER (WHERE ${rigsTable.status} = 'available' AND ${rigsTable.approvalStatus} = 'approved')`,
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

  const now = Date.now();
  const since24h = new Date(now - 24 * 3600 * 1000);
  const startOfTodayUtc = new Date(
    Date.UTC(
      new Date(now).getUTCFullYear(),
      new Date(now).getUTCMonth(),
      new Date(now).getUTCDate(),
    ),
  );
  const since7d = new Date(now - 7 * 24 * 3600 * 1000);
  const since30d = new Date(now - 30 * 24 * 3600 * 1000);

  const [last24] = await db
    .select({
      vol: sql<string>`COALESCE(SUM(${rentalsTable.renterTotalUsd}), 0)`,
      cnt: sql<string>`COUNT(*)`,
    })
    .from(rentalsTable)
    .where(gte(rentalsTable.createdAt, since24h));

  const [today] = await db
    .select({
      vol: sql<string>`COALESCE(SUM(${rentalsTable.renterTotalUsd}), 0)`,
      fee: sql<string>`COALESCE(SUM(${rentalsTable.platformFeeUsd}), 0)`,
    })
    .from(rentalsTable)
    .where(gte(rentalsTable.createdAt, startOfTodayUtc));

  const [week] = await db
    .select({
      vol: sql<string>`COALESCE(SUM(${rentalsTable.renterTotalUsd}), 0)`,
      fee: sql<string>`COALESCE(SUM(${rentalsTable.platformFeeUsd}), 0)`,
    })
    .from(rentalsTable)
    .where(gte(rentalsTable.createdAt, since7d));

  const [month] = await db
    .select({
      vol: sql<string>`COALESCE(SUM(${rentalsTable.renterTotalUsd}), 0)`,
      fee: sql<string>`COALESCE(SUM(${rentalsTable.platformFeeUsd}), 0)`,
    })
    .from(rentalsTable)
    .where(gte(rentalsTable.createdAt, since30d));

  // Total hashrate currently under active rental (units vary by algorithm; this is a rough demand signal).
  const [activeHr] = await db
    .select({
      sum: sql<string>`COALESCE(SUM(${rentalsTable.hashrate}), 0)`,
    })
    .from(rentalsTable)
    .where(eq(rentalsTable.status, "active"));

  const [pending] = await db
    .select({
      sum: sql<string>`COALESCE(SUM(${withdrawalsTable.amountUsd}), 0)`,
    })
    .from(withdrawalsTable)
    .where(eq(withdrawalsTable.status, "pending"));

  // Top algorithms by 30-day rental demand (USD volume).
  const topAlgoRows = await db
    .select({
      algorithmId: algorithmsTable.id,
      algorithmName: algorithmsTable.name,
      unit: algorithmsTable.unit,
      rentalCount: sql<string>`COUNT(${rentalsTable.id})`,
      totalVolumeUsd: sql<string>`COALESCE(SUM(${rentalsTable.renterTotalUsd}), 0)`,
    })
    .from(rentalsTable)
    .innerJoin(rigsTable, eq(rigsTable.id, rentalsTable.rigId))
    .innerJoin(algorithmsTable, eq(algorithmsTable.id, rigsTable.algorithmId))
    .where(gte(rentalsTable.createdAt, since30d))
    .groupBy(algorithmsTable.id)
    .orderBy(sql`COALESCE(SUM(${rentalsTable.renterTotalUsd}), 0) DESC`)
    .limit(5);

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
    currentlyRentedHashrate: toNum(activeHr?.sum),
    grossRevenueTodayUsd: toNum(today?.vol),
    grossRevenueWeekUsd: toNum(week?.vol),
    grossRevenueMonthUsd: toNum(month?.vol),
    commissionTodayUsd: toNum(today?.fee),
    commissionWeekUsd: toNum(week?.fee),
    commissionMonthUsd: toNum(month?.fee),
    topAlgorithmsByDemand: topAlgoRows.map((r) => ({
      algorithmId: r.algorithmId,
      algorithmName: r.algorithmName,
      unit: r.unit,
      rentalCount: Number(r.rentalCount),
      totalVolumeUsd: toNum(r.totalVolumeUsd),
    })),
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
  const amountStr = toUsdString(body.amountUsd);
  const isCredit = body.amountUsd >= 0;

  const result = await db.transaction(async (tx) => {
    // Atomic update — for debits, refuse to drive balance negative.
    const [adjusted] = await tx
      .update(usersTable)
      .set(
        isCredit
          ? {
              balanceUsd: sql`${usersTable.balanceUsd} + ${amountStr}`,
              totalDepositedUsd: sql`${usersTable.totalDepositedUsd} + ${amountStr}`,
            }
          : {
              balanceUsd: sql`${usersTable.balanceUsd} + ${amountStr}`,
            },
      )
      .where(
        isCredit
          ? eq(usersTable.id, body.userId)
          : sql`${usersTable.id} = ${body.userId} AND ${usersTable.balanceUsd} + ${amountStr} >= 0`,
      )
      .returning({ balanceUsd: usersTable.balanceUsd });
    if (!adjusted) return { error: "balance" as const };

    await tx.insert(walletTransactionsTable).values({
      userId: body.userId,
      type: isCredit ? "admin_credit" : "admin_debit",
      amountUsd: amountStr,
      balanceAfterUsd: toUsdString(round6(toNum(adjusted.balanceUsd))),
      memo: body.memo,
    });
    return { ok: true as const };
  });

  if ("error" in result) {
    res
      .status(400)
      .json({ error: "Adjustment would create a negative balance" });
    return;
  }

  // Return the updated wallet snapshot per spec.
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, body.userId));
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  const txns = await db
    .select()
    .from(walletTransactionsTable)
    .where(eq(walletTransactionsTable.userId, user.id))
    .orderBy(desc(walletTransactionsTable.createdAt))
    .limit(50);
  const [pending] = await db
    .select({
      sum: sql<string>`COALESCE(SUM(${withdrawalsTable.amountUsd}), 0)`,
    })
    .from(withdrawalsTable)
    .where(
      sql`${withdrawalsTable.userId} = ${user.id} AND ${withdrawalsTable.status} = 'pending'`,
    );

  const data = AdminCreditWalletResponse.parse({
    balanceUsd: toNum(user.balanceUsd),
    pendingWithdrawalsUsd: toNum(pending?.sum),
    totalDepositedUsd: toNum(user.totalDepositedUsd),
    totalEarnedUsd: toNum(user.totalEarnedUsd),
    totalSpentUsd: toNum(user.totalSpentUsd),
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

router.get("/admin/commission", async (_req, res) => {
  const c = await getCommission();
  const [row] = await db.select().from(commissionConfigTable).limit(1);
  const data = GetCommissionConfigResponse.parse({
    renterFeePct: c.renterFeePct,
    ownerFeePct: c.ownerFeePct,
    cancellationFeePct: c.cancellationFeePct,
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
      cancellationFeePct: (body.cancellationFeePct ?? 0).toString(),
    });
  } else {
    const patch: Record<string, unknown> = {};
    if (body.renterFeePct !== undefined)
      patch["renterFeePct"] = body.renterFeePct.toString();
    if (body.ownerFeePct !== undefined)
      patch["ownerFeePct"] = body.ownerFeePct.toString();
    if (body.cancellationFeePct !== undefined)
      patch["cancellationFeePct"] = body.cancellationFeePct.toString();
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
    cancellationFeePct: c.cancellationFeePct,
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
  if (!created) {
    res.status(500).json({ error: "Failed to create algorithm" });
    return;
  }
  res.status(201).json({
    id: created.id,
    name: created.name,
    slug: created.slug,
    unit: created.unit,
    basePricePerUnitPerHour: toNum(created.basePricePerUnitPerHour),
    rigCount: 0,
    totalHashrate: 0,
    averagePricePerUnitPerHour: toNum(created.basePricePerUnitPerHour),
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
  if (Object.keys(patch).length > 0) {
    await db
      .update(algorithmsTable)
      .set(patch)
      .where(eq(algorithmsTable.id, id));
  }
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

// ============================================================================
// Rig approval queue
// ============================================================================
async function loadAdminRig(id: number) {
  const [row] = await db
    .select({
      id: rigsTable.id,
      name: rigsTable.name,
      description: rigsTable.description,
      ownerId: rigsTable.ownerId,
      ownerEmail: usersTable.email,
      ownerDisplayName: usersTable.displayName,
      algorithmId: algorithmsTable.id,
      algorithmName: algorithmsTable.name,
      algorithmUnit: algorithmsTable.unit,
      basePricePerUnitPerHour: algorithmsTable.basePricePerUnitPerHour,
      pricePerUnitPerDay: rigsTable.pricePerUnitPerDay,
      hashrate: rigsTable.hashrate,
      region: rigsTable.region,
      status: rigsTable.status,
      approvalStatus: rigsTable.approvalStatus,
      approvalNote: rigsTable.approvalNote,
      approvedAt: rigsTable.approvedAt,
      createdAt: rigsTable.createdAt,
    })
    .from(rigsTable)
    .innerJoin(usersTable, eq(usersTable.id, rigsTable.ownerId))
    .innerJoin(algorithmsTable, eq(algorithmsTable.id, rigsTable.algorithmId))
    .where(eq(rigsTable.id, id));
  if (!row) return null;
  const c = await getCommission();
  const renterMultiplier = 1 + c.renterFeePct / 100;
  const ownerPerDay = row.pricePerUnitPerDay == null ? null : toNum(row.pricePerUnitPerDay);
  const effectivePerHour = ownerPerDay != null ? ownerPerDay / 24 : toNum(row.basePricePerUnitPerHour);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    ownerId: row.ownerId,
    ownerEmail: row.ownerEmail,
    ownerDisplayName: row.ownerDisplayName,
    algorithmId: row.algorithmId,
    algorithmName: row.algorithmName,
    algorithmUnit: row.algorithmUnit,
    hashrate: toNum(row.hashrate),
    pricePerUnitPerHour: effectivePerHour * renterMultiplier,
    pricePerUnitPerDay: ownerPerDay,
    region: row.region,
    status: row.status,
    approvalStatus: row.approvalStatus,
    approvalNote: row.approvalNote,
    approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

router.get("/admin/rigs", async (req, res) => {
  const params = ListAdminRigsQueryParams.parse(req.query);
  const c = await getCommission();
  const renterMultiplier = 1 + c.renterFeePct / 100;

  const rows = await db
    .select({
      id: rigsTable.id,
      name: rigsTable.name,
      description: rigsTable.description,
      ownerId: rigsTable.ownerId,
      ownerEmail: usersTable.email,
      ownerDisplayName: usersTable.displayName,
      algorithmId: algorithmsTable.id,
      algorithmName: algorithmsTable.name,
      algorithmUnit: algorithmsTable.unit,
      basePricePerUnitPerHour: algorithmsTable.basePricePerUnitPerHour,
      pricePerUnitPerDay: rigsTable.pricePerUnitPerDay,
      hashrate: rigsTable.hashrate,
      region: rigsTable.region,
      status: rigsTable.status,
      approvalStatus: rigsTable.approvalStatus,
      approvalNote: rigsTable.approvalNote,
      approvedAt: rigsTable.approvedAt,
      createdAt: rigsTable.createdAt,
    })
    .from(rigsTable)
    .innerJoin(usersTable, eq(usersTable.id, rigsTable.ownerId))
    .innerJoin(algorithmsTable, eq(algorithmsTable.id, rigsTable.algorithmId))
    .where(
      params.approvalStatus
        ? eq(rigsTable.approvalStatus, params.approvalStatus)
        : undefined,
    )
    .orderBy(desc(rigsTable.createdAt));

  const data = ListAdminRigsResponse.parse(
    rows.map((r) => {
      const ownerPerDay = r.pricePerUnitPerDay == null ? null : toNum(r.pricePerUnitPerDay);
      const effectivePerHour = ownerPerDay != null ? ownerPerDay / 24 : toNum(r.basePricePerUnitPerHour);
      return {
      id: r.id,
      name: r.name,
      description: r.description,
      ownerId: r.ownerId,
      ownerEmail: r.ownerEmail,
      ownerDisplayName: r.ownerDisplayName,
      algorithmId: r.algorithmId,
      algorithmName: r.algorithmName,
      algorithmUnit: r.algorithmUnit,
      hashrate: toNum(r.hashrate),
      pricePerUnitPerHour: effectivePerHour * renterMultiplier,
      pricePerUnitPerDay: ownerPerDay,
      region: r.region,
      status: r.status,
      approvalStatus: r.approvalStatus,
      approvalNote: r.approvalNote,
      approvedAt: r.approvedAt ? r.approvedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
      };
    }),
  );
  res.json(data);
});

router.post("/admin/rigs/:id/approve", async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const body = ApproveRigBody.parse(req.body ?? {});
  const [updated] = await db
    .update(rigsTable)
    .set({
      approvalStatus: "approved",
      approvalNote: body.note ?? null,
      approvedAt: new Date(),
      status: "available",
    })
    .where(eq(rigsTable.id, id))
    .returning({ id: rigsTable.id });
  if (!updated) {
    res.status(404).json({ error: "Rig not found" });
    return;
  }
  const detail = await loadAdminRig(updated.id);
  res.json(ApproveRigResponse.parse(detail));
});

router.post("/admin/rigs/:id/reject", async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const body = RejectRigBody.parse(req.body ?? {});
  const [updated] = await db
    .update(rigsTable)
    .set({
      approvalStatus: "rejected",
      approvalNote: body.note ?? null,
      approvedAt: new Date(),
    })
    .where(eq(rigsTable.id, id))
    .returning({ id: rigsTable.id });
  if (!updated) {
    res.status(404).json({ error: "Rig not found" });
    return;
  }
  const detail = await loadAdminRig(updated.id);
  res.json(RejectRigResponse.parse(detail));
});

router.patch("/admin/rigs/:id/status", async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const body = SetAdminRigStatusBody.parse(req.body ?? {});
  const [updated] = await db
    .update(rigsTable)
    .set({ status: body.status })
    .where(eq(rigsTable.id, id))
    .returning({ id: rigsTable.id });
  if (!updated) {
    res.status(404).json({ error: "Rig not found" });
    return;
  }
  const detail = await loadAdminRig(updated.id);
  res.json(SetAdminRigStatusResponse.parse(detail));
});

// ============================================================================
// All rentals + full ledger
// ============================================================================
router.get("/admin/rentals", async (_req, res) => {
  await settleExpiredRentals();
  const rows = await db
    .select({
      id: rentalsTable.id,
      rigId: rentalsTable.rigId,
      rigName: rigsTable.name,
      algorithmName: algorithmsTable.name,
      algorithmUnit: algorithmsTable.unit,
      renterId: rentalsTable.renterId,
      renterEmail: usersTable.email,
      ownerId: rentalsTable.ownerId,
      hashrate: rentalsTable.hashrate,
      deliveredHashrateAvg: rentalsTable.deliveredHashrateAvg,
      hours: rentalsTable.hours,
      renterTotalUsd: rentalsTable.renterTotalUsd,
      ownerEarningsUsd: rentalsTable.ownerEarningsUsd,
      platformFeeUsd: rentalsTable.platformFeeUsd,
      status: rentalsTable.status,
      startedAt: rentalsTable.startedAt,
      endsAt: rentalsTable.endsAt,
      cancelledAt: rentalsTable.cancelledAt,
      settledAt: rentalsTable.settledAt,
      createdAt: rentalsTable.createdAt,
    })
    .from(rentalsTable)
    .innerJoin(rigsTable, eq(rigsTable.id, rentalsTable.rigId))
    .innerJoin(algorithmsTable, eq(algorithmsTable.id, rigsTable.algorithmId))
    .innerJoin(usersTable, eq(usersTable.id, rentalsTable.renterId))
    .orderBy(desc(rentalsTable.createdAt));

  // Compute the actual money that has moved per rental so the admin sees
  // what was really paid / earned, not just the contract amounts.
  const rentalIds = rows.map((r) => r.id);
  const txRows = rentalIds.length
    ? await db
        .select({
          rentalId: walletTransactionsTable.relatedRentalId,
          type: walletTransactionsTable.type,
          total: sql<string>`COALESCE(SUM(${walletTransactionsTable.amountUsd}), 0)`,
        })
        .from(walletTransactionsTable)
        .where(
          and(
            inArray(walletTransactionsTable.relatedRentalId, rentalIds),
            inArray(walletTransactionsTable.type, [
              "rental_refund",
              "rental_payout",
            ]),
          ),
        )
        .groupBy(walletTransactionsTable.relatedRentalId, walletTransactionsTable.type)
    : [];
  const refundMap = new Map<number, number>();
  const payoutMap = new Map<number, number>();
  for (const t of txRows) {
    if (t.rentalId == null) continue;
    if (t.type === "rental_refund") refundMap.set(t.rentalId, toNum(t.total));
    else if (t.type === "rental_payout") payoutMap.set(t.rentalId, toNum(t.total));
  }

  const ownerIds = Array.from(new Set(rows.map((r) => r.ownerId)));
  const owners = ownerIds.length
    ? await db
        .select({ id: usersTable.id, email: usersTable.email })
        .from(usersTable)
        .where(inArray(usersTable.id, ownerIds))
    : [];
  const ownerMap = new Map(owners.map((o) => [o.id, o.email]));

  const data = ListAdminRentalsResponse.parse(
    rows.map((r) => ({
      id: r.id,
      rigId: r.rigId,
      rigName: r.rigName,
      algorithmName: r.algorithmName,
      algorithmUnit: r.algorithmUnit,
      renterId: r.renterId,
      renterEmail: r.renterEmail,
      ownerId: r.ownerId,
      ownerEmail: ownerMap.get(r.ownerId) ?? "",
      hashrate: toNum(r.hashrate),
      hours: r.hours,
      renterTotalUsd: toNum(r.renterTotalUsd),
      netRenterPaidUsd: round6(
        Math.max(0, toNum(r.renterTotalUsd) - (refundMap.get(r.id) ?? 0)),
      ),
      ownerEarningsUsd: toNum(r.ownerEarningsUsd),
      netOwnerEarnedUsd: round6(payoutMap.get(r.id) ?? 0),
      platformFeeUsd: toNum(r.platformFeeUsd),
      frozenUsd: (() => {
        if (r.status !== "disputed") return 0;
        const totalSec = (r.endsAt.getTime() - r.startedAt.getTime()) / 1000;
        const cancelledAt = r.cancelledAt ?? new Date();
        const usedSec = Math.max(
          0,
          Math.min(totalSec, (cancelledAt.getTime() - r.startedAt.getTime()) / 1000),
        );
        const usedRatio = totalSec > 0 ? usedSec / totalSec : 1;
        const dr = computeDeliveryRatio(r.deliveredHashrateAvg, r.hashrate);
        return round6(toNum(r.renterTotalUsd) * usedRatio * (1 - dr));
      })(),
      status: r.status,
      startedAt: r.startedAt.toISOString(),
      endsAt: r.endsAt.toISOString(),
      cancelledAt: r.cancelledAt ? r.cancelledAt.toISOString() : null,
      settledAt: r.settledAt ? r.settledAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    })),
  );
  res.json(data);
});

router.get("/admin/wallet/transactions", async (req, res) => {
  const params = ListAdminWalletTransactionsQueryParams.parse(req.query);
  const limit = params.limit ?? 100;
  const rows = await db
    .select({
      id: walletTransactionsTable.id,
      userId: walletTransactionsTable.userId,
      userEmail: usersTable.email,
      userDisplayName: usersTable.displayName,
      type: walletTransactionsTable.type,
      amountUsd: walletTransactionsTable.amountUsd,
      balanceAfterUsd: walletTransactionsTable.balanceAfterUsd,
      memo: walletTransactionsTable.memo,
      relatedRentalId: walletTransactionsTable.relatedRentalId,
      createdAt: walletTransactionsTable.createdAt,
    })
    .from(walletTransactionsTable)
    .innerJoin(usersTable, eq(usersTable.id, walletTransactionsTable.userId))
    .orderBy(desc(walletTransactionsTable.createdAt))
    .limit(limit);

  const data = ListAdminWalletTransactionsResponse.parse(
    rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      userEmail: r.userEmail,
      userDisplayName: r.userDisplayName,
      type: r.type,
      amountUsd: toNum(r.amountUsd),
      balanceAfterUsd: toNum(r.balanceAfterUsd),
      memo: r.memo,
      relatedRentalId: r.relatedRentalId,
      createdAt: r.createdAt.toISOString(),
    })),
  );
  res.json(data);
});

// ============================================================================
// Withdrawals queue
// ============================================================================
router.get("/admin/withdrawals", async (_req, res) => {
  const [rows, walletSettings] = await Promise.all([
    db
      .select({
        id: withdrawalsTable.id,
        userId: withdrawalsTable.userId,
        userEmail: usersTable.email,
        userDisplayName: usersTable.displayName,
        asset: withdrawalsTable.asset,
        destinationAddress: withdrawalsTable.destinationAddress,
        amountUsd: withdrawalsTable.amountUsd,
        status: withdrawalsTable.status,
        adminNote: withdrawalsTable.adminNote,
        onChainTxid: withdrawalsTable.onChainTxid,
        createdAt: withdrawalsTable.createdAt,
      })
      .from(withdrawalsTable)
      .innerJoin(usersTable, eq(usersTable.id, withdrawalsTable.userId))
      .orderBy(desc(withdrawalsTable.createdAt)),
    getWalletSettings(),
  ]);

  const data = ListAdminWithdrawalsResponse.parse(
    rows.map((r) => {
      const feeUsd = r.asset === "BTC"
        ? walletSettings.btcWithdrawalFeeUsd
        : walletSettings.usdtTrc20WithdrawalFeeUsd;
      const amountUsd = toNum(r.amountUsd);
      return {
        id: r.id,
        userId: r.userId,
        userEmail: r.userEmail,
        userDisplayName: r.userDisplayName,
        asset: r.asset,
        destinationAddress: r.destinationAddress,
        amountUsd,
        feeUsd,
        netAmountUsd: Math.max(0, amountUsd - feeUsd),
        status: r.status,
        adminNote: r.adminNote ?? undefined,
        onChainTxid: r.onChainTxid ?? undefined,
        createdAt: r.createdAt.toISOString(),
      };
    }),
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
  // Only flip pending→approved atomically.
  const [updated] = await db
    .update(withdrawalsTable)
    .set({
      status: "approved",
      adminNote: body.adminNote ?? null,
      decidedAt: new Date(),
    })
    .where(
      sql`${withdrawalsTable.id} = ${id} AND ${withdrawalsTable.status} = 'pending'`,
    )
    .returning();
  if (!updated) {
    res.status(400).json({ error: "Withdrawal not found or already decided" });
    return;
  }
  const data = ApproveWithdrawalResponse.parse({
    id: updated.id,
    userId: updated.userId,
    asset: updated.asset,
    destinationAddress: updated.destinationAddress,
    amountUsd: toNum(updated.amountUsd),
    status: updated.status,
    adminNote: updated.adminNote,
    onChainTxid: updated.onChainTxid ?? null,
    createdAt: updated.createdAt.toISOString(),
    decidedAt: updated.decidedAt ? updated.decidedAt.toISOString() : null,
    sentAt: updated.sentAt ? updated.sentAt.toISOString() : null,
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

  const result = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(withdrawalsTable)
      .set({
        status: "rejected",
        adminNote: body.adminNote ?? null,
        decidedAt: new Date(),
      })
      .where(
        sql`${withdrawalsTable.id} = ${id} AND ${withdrawalsTable.status} IN ('pending', 'approved')`,
      )
      .returning();
    if (!updated) return null;

    // Refund the held balance back to the user. Throw on failure so the
    // entire transaction rolls back — the withdrawal must not be marked
    // rejected without the user being credited.
    const refundStr = updated.amountUsd;
    const [credited] = await tx
      .update(usersTable)
      .set({
        balanceUsd: sql`${usersTable.balanceUsd} + ${refundStr}`,
      })
      .where(eq(usersTable.id, updated.userId))
      .returning({ balanceUsd: usersTable.balanceUsd });
    if (!credited) throw new Error("Failed to credit refund for rejected withdrawal");

    await tx.insert(walletTransactionsTable).values({
      userId: updated.userId,
      type: "admin_credit",
      amountUsd: refundStr,
      balanceAfterUsd: toUsdString(round6(toNum(credited.balanceUsd))),
      memo: `Refund for rejected withdrawal #${updated.id}`,
    });
    return updated;
  });

  if (!result) {
    res.status(400).json({ error: "Withdrawal not found or already decided" });
    return;
  }
  const data = RejectWithdrawalResponse.parse({
    id: result.id,
    userId: result.userId,
    asset: result.asset,
    destinationAddress: result.destinationAddress,
    amountUsd: toNum(result.amountUsd),
    status: result.status,
    adminNote: result.adminNote,
    onChainTxid: result.onChainTxid ?? null,
    createdAt: result.createdAt.toISOString(),
    decidedAt: result.decidedAt ? result.decidedAt.toISOString() : null,
    sentAt: result.sentAt ? result.sentAt.toISOString() : null,
  });
  res.json(data);
});

router.get("/admin/deposits/unmatched", async (_req, res) => {
  const rows = await db
    .select()
    .from(cryptoDepositsTable)
    .where(eq(cryptoDepositsTable.status, "unmatched"))
    .orderBy(desc(cryptoDepositsTable.detectedAt));

  res.json(
    rows.map((d) => ({
      id: d.id,
      currency: d.currency,
      amountCrypto: d.amountCrypto,
      amountUsd: d.amountUsd ? toNum(d.amountUsd) : null,
      txid: d.txid,
      processorPaymentId: d.processorPaymentId,
      status: d.status,
      detectedAt: d.detectedAt.toISOString(),
      processorData: d.processorData,
    })),
  );
});

router.post("/admin/withdrawals/:id/mark-sent", async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const body = (req.body ?? {}) as { onChainTxid?: string; sendViaNowpayments?: boolean };

  // Atomically claim the withdrawal: only one admin/retry can proceed past here.
  // Use status transition pending|approved → sending to act as a distributed lock.
  const [claimed] = await db
    .update(withdrawalsTable)
    .set({ status: "sending", decidedAt: new Date() })
    .where(sql`${withdrawalsTable.id} = ${id} AND ${withdrawalsTable.status} IN ('pending', 'approved')`)
    .returning();

  if (!claimed) {
    res.status(409).json({ error: "Withdrawal not found, already processing, or already sent/rejected" });
    return;
  }

  const withdrawal = claimed;
  const walletSettings = await getWalletSettings();
  const feeUsd = withdrawal.asset === "BTC"
    ? walletSettings.btcWithdrawalFeeUsd
    : walletSettings.usdtTrc20WithdrawalFeeUsd;
  const netAmountUsd = Math.max(0, toNum(withdrawal.amountUsd) - feeUsd);

  let finalTxid = body.onChainTxid?.trim() ?? null;
  let processorPaymentId: string | null = null;

  if (body.sendViaNowpayments !== false && nowpaymentsConfigured() && netAmountUsd > 0) {
    const currency = withdrawal.asset === "BTC" ? "btc" : "usdt_trc20";
    const npCurrency: NpCurrency = currency === "btc" ? "btc" : "usdttrc20";
    const cryptoAmount = await usdToCrypto(netAmountUsd, currency);
    if (cryptoAmount <= 0) {
      // Revert to approved so admin can retry
      await db.update(withdrawalsTable).set({ status: "approved" }).where(eq(withdrawalsTable.id, id));
      res.status(400).json({ error: "Cannot compute crypto amount — check rate configuration" });
      return;
    }
    try {
      const payout = await createPayout({
        address: withdrawal.destinationAddress,
        currency: npCurrency,
        amount: cryptoAmount,
        extra_id: `withdrawal-${withdrawal.id}`,
      });
      processorPaymentId = payout.id;
      finalTxid = payout.hash ?? finalTxid;
    } catch (err) {
      // Revert to approved so admin can retry
      await db.update(withdrawalsTable).set({ status: "approved" }).where(eq(withdrawalsTable.id, id));
      const msg = err instanceof Error ? err.message : String(err);
      res.status(502).json({ error: `NOWPayments payout failed: ${msg}` });
      return;
    }
  } else if (!finalTxid || finalTxid.length < 4) {
    // Revert to approved so admin can retry
    await db.update(withdrawalsTable).set({ status: "approved" }).where(eq(withdrawalsTable.id, id));
    res.status(400).json({ error: "onChainTxid is required (min 4 characters) when not using auto-send" });
    return;
  }

  const [updated] = await db
    .update(withdrawalsTable)
    .set({
      status: "sent",
      onChainTxid: finalTxid,
      processorPaymentId,
      sentAt: new Date(),
      decidedAt: new Date(),
    })
    .where(sql`${withdrawalsTable.id} = ${id}`)
    .returning();

  res.json({
    id: updated!.id,
    userId: updated!.userId,
    asset: updated!.asset,
    destinationAddress: updated!.destinationAddress,
    amountUsd: toNum(updated!.amountUsd),
    netAmountUsd,
    feeUsd,
    status: updated!.status,
    adminNote: updated!.adminNote,
    onChainTxid: updated!.onChainTxid,
    processorPaymentId: updated!.processorPaymentId,
    createdAt: updated!.createdAt.toISOString(),
    decidedAt: updated!.decidedAt ? updated!.decidedAt.toISOString() : null,
    sentAt: updated!.sentAt ? updated!.sentAt.toISOString() : null,
  });
});

router.post("/admin/withdrawals/:id/confirm", async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const body = (req.body ?? {}) as { onChainTxid?: string };

  const [updated] = await db
    .update(withdrawalsTable)
    .set({
      status: "confirmed",
      onChainTxid: body.onChainTxid?.trim() ?? undefined,
      decidedAt: new Date(),
    })
    .where(sql`${withdrawalsTable.id} = ${id} AND ${withdrawalsTable.status} = 'sent'`)
    .returning();

  if (!updated) {
    res.status(400).json({ error: "Withdrawal not found or not in 'sent' state" });
    return;
  }

  res.json({
    id: updated.id,
    status: updated.status,
    onChainTxid: updated.onChainTxid,
    decidedAt: updated.decidedAt?.toISOString() ?? null,
  });
});

router.get("/admin/proxy", (req, res) => {
  const status = proxyState.getAdminStatus();
  res.json({
    connectedRigs: status.connectedRigs.map((r) => ({
      rigId: r.rigId,
      rigName: r.rigName,
      connectedAt: r.connectedAt.toISOString(),
      authorized: r.authorized,
      rentalId: r.rentalId,
      sharesAccepted: r.sharesAccepted,
      sharesRejected: r.sharesRejected,
      lastShareAt: r.lastShareAt ? r.lastShareAt.toISOString() : null,
      upstreamConnected: r.upstreamConnected,
      submitsDropped: r.submitsDropped,
      upstreamErrors: r.upstreamErrors,
      upstreamDisconnects: r.upstreamDisconnects,
    })),
    activeRoutes: status.activeRoutes,
    totalSharesThisSession: status.totalSharesThisSession,
    currentSharesPerSec: status.currentSharesPerSec,
  });
});

router.post("/admin/proxy/rigs/:rigId/disconnect", (req, res) => {
  const rigId = Number(req.params["rigId"]);
  if (!Number.isFinite(rigId)) {
    res.status(400).json({ error: "Invalid rigId" });
    return;
  }
  const ok = proxyState.forceDisconnect(rigId);
  if (!ok) {
    res.status(404).json({ error: "Rig not currently connected" });
    return;
  }
  res.json({ ok: true, message: `Rig ${rigId} disconnected` });
});

/**
 * GET /admin/proxy/settings — return current proxy policy settings.
 * PUT /admin/proxy/settings — update one or more proxy policy settings.
 */
router.get("/admin/proxy/settings", async (_req, res) => {
  const settings = await getProxySettings();
  res.json({
    settings,
    defaults: proxySettingsDefaults,
    keys: {
      lowDeliveryThresholdPct: "low_delivery_threshold_pct",
      lowDeliveryWindowSec: "low_delivery_window_sec",
      minSharesForCheck: "min_shares_for_check",
    },
  });
});

router.put("/admin/proxy/settings", async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const allowed: Record<string, (v: number) => boolean> = {
    low_delivery_threshold_pct: (v) => v >= 0 && v <= 1,
    low_delivery_window_sec: (v) => v >= 60 && v <= 86400,
    min_shares_for_check: (v) => v >= 0 && v <= 10000,
  };
  const updates: Array<{ key: string; value: string }> = [];
  for (const [key, validator] of Object.entries(allowed)) {
    if (key in body) {
      const raw = Number(body[key]);
      if (!Number.isFinite(raw) || !validator(raw)) {
        res.status(400).json({ error: `Invalid value for ${key}` });
        return;
      }
      updates.push({ key, value: String(raw) });
    }
  }
  if (updates.length === 0) {
    res.status(400).json({ error: "No valid settings provided" });
    return;
  }
  for (const { key, value } of updates) {
    await setProxySetting(key, value);
  }
  const updated = await getProxySettings();
  res.json({ ok: true, settings: updated });
});

router.get("/admin/wallet/settings", async (_req, res) => {
  const settings = await getWalletSettings();
  res.json({ settings, defaults: walletSettingsDefaults });
});

router.put("/admin/wallet/settings", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  type StringValidator = { type: "string"; validate?: (v: string) => boolean };
  type NumberValidator = { type: "number"; validate: (v: number) => boolean };
  type FieldSpec = StringValidator | NumberValidator;

  const allowed: Record<string, FieldSpec> = {
    wallet_enabled_currencies: {
      type: "string",
      validate: (v: string) =>
        v === "" ||
        v.split(",").every((c) => ["btc", "usdt_trc20"].includes(c.trim())),
    },
    wallet_btc_min_deposit_usd: { type: "number", validate: (v) => v >= 0 },
    wallet_usdt_trc20_min_deposit_usd: { type: "number", validate: (v) => v >= 0 },
    wallet_btc_required_confirmations: { type: "number", validate: (v) => v >= 1 && v <= 100 },
    wallet_usdt_trc20_required_confirmations: { type: "number", validate: (v) => v >= 1 && v <= 100 },
    wallet_btc_withdrawal_fee_usd: { type: "number", validate: (v) => v >= 0 },
    wallet_usdt_trc20_withdrawal_fee_usd: { type: "number", validate: (v) => v >= 0 },
    wallet_daily_withdrawal_cap_usd: { type: "number", validate: (v) => v >= 0 },
    wallet_rate_source: {
      type: "string",
      validate: (v: string) => ["coingecko", "fixed"].includes(v),
    },
    wallet_fixed_btc_usd: { type: "number", validate: (v) => v >= 0 },
    wallet_fixed_usdt_usd: { type: "number", validate: (v) => v >= 0 },
  };

  const updates: Array<{ key: string; value: string }> = [];
  for (const [key, spec] of Object.entries(allowed)) {
    if (!(key in body)) continue;
    if (spec.type === "number") {
      const raw = Number(body[key]);
      if (!Number.isFinite(raw) || !spec.validate(raw)) {
        res.status(400).json({ error: `Invalid value for ${key}` });
        return;
      }
      updates.push({ key, value: String(raw) });
    } else {
      const raw = String(body[key] ?? "").trim();
      if (spec.validate && !spec.validate(raw)) {
        res.status(400).json({ error: `Invalid value for ${key}` });
        return;
      }
      updates.push({ key, value: raw });
    }
  }

  if (updates.length === 0) {
    res.status(400).json({ error: "No valid settings provided" });
    return;
  }
  for (const { key, value } of updates) {
    await setWalletSetting(key, value);
  }
  const updated = await getWalletSettings();
  res.json({ ok: true, settings: updated });
});

// ============================================================================
// Manually resolve a disputed cancellation
// ============================================================================
router.post("/admin/rentals/:id/resolve-dispute", async (req, res) => {
  const rentalId = Number(req.params.id);
  if (!Number.isFinite(rentalId)) {
    res.status(400).json({ error: "Invalid rental id" });
    return;
  }

  const parsed = ResolveRentalDisputeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { award, note, renterAmountUsd } = parsed.data;

  const result = await db.transaction(async (tx) => {
    const [rental] = await tx
      .select()
      .from(rentalsTable)
      .where(eq(rentalsTable.id, rentalId))
      .limit(1);
    if (!rental) return { error: "not_found" as const };
    if (rental.status !== "disputed") {
      return { error: "not_disputed" as const };
    }

    // Compute the frozen amount = renterTotal × usedRatio × (1 − deliveryRatio).
    // The delivered portion was already paid to the owner at dispute time;
    // only the shortfall remains for admin to award.
    const totalSec =
      (rental.endsAt.getTime() - rental.startedAt.getTime()) / 1000;
    const cancelledAt = rental.cancelledAt ?? new Date();
    const usedSec = Math.max(
      0,
      Math.min(totalSec, (cancelledAt.getTime() - rental.startedAt.getTime()) / 1000),
    );
    const usedRatio = totalSec > 0 ? usedSec / totalSec : 1;
    const deliveryRatio = computeDeliveryRatio(rental.deliveredHashrateAvg, rental.hashrate);
    const frozen = round6(toNum(rental.renterTotalUsd) * usedRatio * (1 - deliveryRatio));

    // Decide how to split the frozen amount between renter (refund) and
    // owner (gross before fee). For "renter"/"owner" it's all-or-nothing;
    // for "split" the admin supplies how much goes back to the renter.
    let renterRefund = 0;
    let ownerGross = 0;
    if (award === "renter") {
      renterRefund = frozen;
    } else if (award === "owner") {
      ownerGross = frozen;
    } else {
      // award === "split"
      if (renterAmountUsd == null) {
        return { error: "missing_split_amount" as const };
      }
      const r = round6(renterAmountUsd);
      if (r < 0 || r > frozen + 1e-6) {
        return { error: "split_out_of_range" as const, frozen };
      }
      renterRefund = Math.min(frozen, Math.max(0, r));
      ownerGross = round6(frozen - renterRefund);
    }

    // Atomic claim — flip status away from disputed.
    const [claimed] = await tx
      .update(rentalsTable)
      .set({ status: "cancelled", settledAt: new Date() })
      .where(
        and(eq(rentalsTable.id, rentalId), eq(rentalsTable.status, "disputed")),
      )
      .returning({ id: rentalsTable.id });
    if (!claimed) return { error: "race" as const };

    // Refund renter portion.
    if (renterRefund > 0) {
      const refundStr = toUsdString(renterRefund);
      const [credited] = await tx
        .update(usersTable)
        .set({
          balanceUsd: sql`${usersTable.balanceUsd} + ${refundStr}`,
          totalSpentUsd: sql`GREATEST(0, ${usersTable.totalSpentUsd} - ${refundStr})`,
        })
        .where(eq(usersTable.id, rental.renterId))
        .returning({ balanceUsd: usersTable.balanceUsd });
      if (credited) {
        await tx.insert(walletTransactionsTable).values({
          userId: rental.renterId,
          type: "rental_refund",
          amountUsd: refundStr,
          balanceAfterUsd: toUsdString(round6(toNum(credited.balanceUsd))),
          memo: `Admin resolved dispute for rental #${rental.id} (refund to renter)${note ? ` — ${note}` : ""}`,
          relatedRentalId: rental.id,
        });
      }
    }

    // Credit owner portion at the rental's original owner-share (i.e.
    // platform fee is deducted from the owner's slice of the frozen amount).
    const ownerShare =
      toNum(rental.renterTotalUsd) > 0
        ? toNum(rental.ownerEarningsUsd) / toNum(rental.renterTotalUsd)
        : 0;
    const ownerCredit = round6(ownerGross * ownerShare);
    if (ownerCredit > 0) {
      const creditStr = toUsdString(ownerCredit);
      const [credited] = await tx
        .update(usersTable)
        .set({
          balanceUsd: sql`${usersTable.balanceUsd} + ${creditStr}`,
          totalEarnedUsd: sql`${usersTable.totalEarnedUsd} + ${creditStr}`,
        })
        .where(eq(usersTable.id, rental.ownerId))
        .returning({ balanceUsd: usersTable.balanceUsd });
      if (credited) {
        await tx.insert(walletTransactionsTable).values({
          userId: rental.ownerId,
          type: "rental_payout",
          amountUsd: creditStr,
          balanceAfterUsd: toUsdString(round6(toNum(credited.balanceUsd))),
          memo: `Admin resolved dispute for rental #${rental.id} (payout to owner)${note ? ` — ${note}` : ""}`,
          relatedRentalId: rental.id,
        });
      }
    }

    // Platform's share of the frozen amount. Update platformFeeUsd so the
    // admin panel reflects the total actually retained for this rental.
    const platformShareFromFrozen = round6(ownerGross - ownerCredit);
    if (platformShareFromFrozen > 0) {
      await tx
        .update(rentalsTable)
        .set({ platformFeeUsd: sql`${rentalsTable.platformFeeUsd} + ${toUsdString(platformShareFromFrozen)}` })
        .where(eq(rentalsTable.id, id));
    }

    return {
      ok: true as const,
      renterRefund,
      ownerCredit,
      total: round6(renterRefund + ownerCredit),
    };
  });

  if ("error" in result) {
    if (result.error === "not_found") {
      res.status(404).json({ error: "Rental not found" });
    } else if (result.error === "not_disputed") {
      res.status(400).json({ error: "Rental is not in disputed state" });
    } else if (result.error === "missing_split_amount") {
      res.status(400).json({ error: "renterAmountUsd is required for split award" });
    } else if (result.error === "split_out_of_range") {
      res.status(400).json({
        error: `renterAmountUsd must be between 0 and ${result.frozen.toFixed(6)}`,
      });
    } else {
      res.status(409).json({ error: "Dispute already resolved" });
    }
    return;
  }

  res.json(
    ResolveRentalDisputeResponse.parse({
      rentalId,
      award,
      amountUsd: result.total,
      renterRefundUsd: result.renterRefund,
      ownerCreditUsd: result.ownerCredit,
    }),
  );
});

export default router;
