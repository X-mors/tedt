import { Router, type IRouter } from "express";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  rigsTable,
  rentalsTable,
  walletTransactionsTable,
  withdrawalsTable,
  reviewsTable,
  algorithmsTable,
} from "@workspace/db";
import {
  GetDashboardOwnerSummaryResponse,
  GetDashboardRenterSummaryResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../lib/auth";
import { toNum } from "../lib/money";

const router: IRouter = Router();

router.use(requireAuth);

const startOf = (offsetMs: number) => new Date(Date.now() - offsetMs);
const DAY = 24 * 60 * 60 * 1000;

router.get("/dashboard/owner-summary", async (req, res) => {
  const userId = req.currentUser!.id;
  const today = startOf(DAY);
  const week = startOf(7 * DAY);
  const month = startOf(30 * DAY);

  const [rigCounts] = await db
    .select({
      totalRigs: sql<string>`COUNT(*)`,
      activeRigs: sql<string>`COUNT(*) FILTER (WHERE ${rigsTable.status} = 'available')`,
      pausedRigs: sql<string>`COUNT(*) FILTER (WHERE ${rigsTable.status} = 'paused')`,
      pendingApprovalRigs: sql<string>`COUNT(*) FILTER (WHERE ${rigsTable.approvalStatus} = 'pending')`,
    })
    .from(rigsTable)
    .where(eq(rigsTable.ownerId, userId));

  const ownerRigIds = await db
    .select({ id: rigsTable.id })
    .from(rigsTable)
    .where(eq(rigsTable.ownerId, userId));

  const rigIdList = ownerRigIds.map((r) => r.id);

  const [activeRentalRow] = await db
    .select({ activeRentals: sql<string>`COUNT(*)` })
    .from(rentalsTable)
    .where(
      and(
        eq(rentalsTable.status, "active"),
        rigIdList.length > 0
          ? sql`${rentalsTable.rigId} = ANY(${sql.raw(`ARRAY[${rigIdList.join(",")}]::int[]`)})`
          : sql`false`,
      ),
    );

  const [earnings] = await db
    .select({
      earningsTodayUsd: sql<string>`COALESCE(SUM(${walletTransactionsTable.amountUsd}) FILTER (WHERE ${walletTransactionsTable.createdAt} >= ${today.toISOString()}), 0)`,
      earningsWeekUsd: sql<string>`COALESCE(SUM(${walletTransactionsTable.amountUsd}) FILTER (WHERE ${walletTransactionsTable.createdAt} >= ${week.toISOString()}), 0)`,
      earningsMonthUsd: sql<string>`COALESCE(SUM(${walletTransactionsTable.amountUsd}) FILTER (WHERE ${walletTransactionsTable.createdAt} >= ${month.toISOString()}), 0)`,
      earningsTotalUsd: sql<string>`COALESCE(SUM(${walletTransactionsTable.amountUsd}), 0)`,
    })
    .from(walletTransactionsTable)
    .where(
      and(
        eq(walletTransactionsTable.userId, userId),
        eq(walletTransactionsTable.type, "rental_payout"),
      ),
    );

  const [pendingWithdrawRow] = await db
    .select({ pendingWithdrawalsUsd: sql<string>`COALESCE(SUM(${withdrawalsTable.amountUsd}), 0)` })
    .from(withdrawalsTable)
    .where(and(eq(withdrawalsTable.userId, userId), eq(withdrawalsTable.status, "pending")));

  const [ratingRow] = await db
    .select({ averageRating: sql<string | null>`AVG(${reviewsTable.rating})` })
    .from(reviewsTable)
    .innerJoin(rentalsTable, eq(rentalsTable.id, reviewsTable.rentalId))
    .where(
      rigIdList.length > 0
        ? sql`${rentalsTable.rigId} = ANY(${sql.raw(`ARRAY[${rigIdList.join(",")}]::int[]`)})`
        : sql`false`,
    );

  const data = GetDashboardOwnerSummaryResponse.parse({
    totalRigs: Number(rigCounts?.totalRigs ?? 0),
    activeRigs: Number(rigCounts?.activeRigs ?? 0),
    pausedRigs: Number(rigCounts?.pausedRigs ?? 0),
    pendingApprovalRigs: Number(rigCounts?.pendingApprovalRigs ?? 0),
    activeRentals: Number(activeRentalRow?.activeRentals ?? 0),
    earningsTodayUsd: toNum(earnings?.earningsTodayUsd ?? "0"),
    earningsWeekUsd: toNum(earnings?.earningsWeekUsd ?? "0"),
    earningsMonthUsd: toNum(earnings?.earningsMonthUsd ?? "0"),
    earningsTotalUsd: toNum(earnings?.earningsTotalUsd ?? "0"),
    pendingWithdrawalsUsd: toNum(pendingWithdrawRow?.pendingWithdrawalsUsd ?? "0"),
    averageRating: ratingRow?.averageRating == null ? null : Number(toNum(ratingRow.averageRating).toFixed(2)),
  });

  res.json(data);
});

router.get("/dashboard/renter-summary", async (req, res) => {
  const userId = req.currentUser!.id;
  const today = startOf(DAY);
  const week = startOf(7 * DAY);
  const month = startOf(30 * DAY);

  const [rentalCounts] = await db
    .select({
      activeRentals: sql<string>`COUNT(*) FILTER (WHERE ${rentalsTable.status} = 'active')`,
      completedRentals: sql<string>`COUNT(*) FILTER (WHERE ${rentalsTable.status} = 'completed')`,
    })
    .from(rentalsTable)
    .where(eq(rentalsTable.renterId, userId));

  const [spending] = await db
    .select({
      spendTodayUsd: sql<string>`COALESCE(ABS(SUM(${walletTransactionsTable.amountUsd})) FILTER (WHERE ${walletTransactionsTable.createdAt} >= ${today.toISOString()}), 0)`,
      spendWeekUsd: sql<string>`COALESCE(ABS(SUM(${walletTransactionsTable.amountUsd})) FILTER (WHERE ${walletTransactionsTable.createdAt} >= ${week.toISOString()}), 0)`,
      spendMonthUsd: sql<string>`COALESCE(ABS(SUM(${walletTransactionsTable.amountUsd})) FILTER (WHERE ${walletTransactionsTable.createdAt} >= ${month.toISOString()}), 0)`,
      spendTotalUsd: sql<string>`COALESCE(ABS(SUM(${walletTransactionsTable.amountUsd})), 0)`,
    })
    .from(walletTransactionsTable)
    .where(
      and(
        eq(walletTransactionsTable.userId, userId),
        eq(walletTransactionsTable.type, "rental_charge"),
      ),
    );

  const [favAlgoRow] = await db
    .select({
      algorithmName: algorithmsTable.name,
      cnt: sql<string>`COUNT(*)`,
    })
    .from(rentalsTable)
    .innerJoin(rigsTable, eq(rigsTable.id, rentalsTable.rigId))
    .innerJoin(algorithmsTable, eq(algorithmsTable.id, rigsTable.algorithmId))
    .where(eq(rentalsTable.renterId, userId))
    .groupBy(algorithmsTable.id, algorithmsTable.name)
    .orderBy(desc(sql`COUNT(*)`))
    .limit(1);

  const [walletRow] = await db
    .select({ balanceUsd: usersTable.balanceUsd })
    .from(usersTable)
    .where(eq(usersTable.id, userId));

  const data = GetDashboardRenterSummaryResponse.parse({
    activeRentals: Number(rentalCounts?.activeRentals ?? 0),
    completedRentals: Number(rentalCounts?.completedRentals ?? 0),
    spendTodayUsd: toNum(spending?.spendTodayUsd ?? "0"),
    spendWeekUsd: toNum(spending?.spendWeekUsd ?? "0"),
    spendMonthUsd: toNum(spending?.spendMonthUsd ?? "0"),
    spendTotalUsd: toNum(spending?.spendTotalUsd ?? "0"),
    favouriteAlgorithm: favAlgoRow?.algorithmName ?? null,
    currentBalanceUsd: toNum(walletRow?.balanceUsd ?? "0"),
  });

  res.json(data);
});

export default router;
