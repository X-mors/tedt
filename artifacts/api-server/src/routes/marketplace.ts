import { Router, type IRouter } from "express";
import { sql, and, eq, desc } from "drizzle-orm";
// `and` is used below to combine status + approval filters on the rigs join.
import {
  db,
  rigsTable,
  algorithmsTable,
  rentalsTable,
  usersTable,
  reviewsTable,
} from "@workspace/db";
import {
  GetMarketplaceSummaryResponse,
  ListAlgorithmsResponse,
} from "@workspace/api-zod";
import { getCommission } from "../lib/commission";
import { toNum } from "../lib/money";

const router: IRouter = Router();

router.get("/algorithms", async (_req, res) => {
  const commission = await getCommission();
  const renterMultiplier = 1 + commission.renterFeePct / 100;

  const rows = await db
    .select({
      id: algorithmsTable.id,
      name: algorithmsTable.name,
      slug: algorithmsTable.slug,
      unit: algorithmsTable.unit,
      basePricePerUnitPerHour: algorithmsTable.basePricePerUnitPerHour,
      rigCount: sql<string>`COALESCE(COUNT(${rigsTable.id}) FILTER (WHERE ${rigsTable.status} = 'available'), 0)`,
      totalHashrate: sql<string>`COALESCE(SUM(${rigsTable.hashrate}) FILTER (WHERE ${rigsTable.status} = 'available'), 0)`,
    })
    .from(algorithmsTable)
    .leftJoin(
      rigsTable,
      and(
        eq(rigsTable.algorithmId, algorithmsTable.id),
        eq(rigsTable.approvalStatus, "approved"),
      ),
    )
    .groupBy(algorithmsTable.id)
    .orderBy(algorithmsTable.name);

  const data = ListAlgorithmsResponse.parse(
    rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      unit: row.unit,
      basePricePerUnitPerHour: toNum(row.basePricePerUnitPerHour),
      rigCount: Number(row.rigCount),
      totalHashrate: toNum(row.totalHashrate),
      averagePricePerUnitPerHour:
        toNum(row.basePricePerUnitPerHour) * renterMultiplier,
    })),
  );

  res.json(data);
});

router.get("/marketplace/summary", async (_req, res) => {
  const commission = await getCommission();
  const renterMultiplier = 1 + commission.renterFeePct / 100;

  const [counts] = await db
    .select({
      availableRigs: sql<string>`COUNT(*) FILTER (WHERE ${rigsTable.status} = 'available' AND ${rigsTable.approvalStatus} = 'approved')`,
    })
    .from(rigsTable);

  const [activeRentalRow] = await db
    .select({
      activeRentals: sql<string>`COUNT(*) FILTER (WHERE ${rentalsTable.status} = 'active')`,
    })
    .from(rentalsTable);

  const [userCounts] = await db
    .select({
      totalLessors: sql<string>`COUNT(DISTINCT ${rigsTable.ownerId})`,
    })
    .from(rigsTable)
    .where(eq(rigsTable.approvalStatus, "approved"));

  const [renterCounts] = await db
    .select({
      totalRenters: sql<string>`COUNT(DISTINCT ${rentalsTable.renterId})`,
    })
    .from(rentalsTable);

  const breakdown = await db
    .select({
      algorithmId: algorithmsTable.id,
      algorithmName: algorithmsTable.name,
      unit: algorithmsTable.unit,
      basePricePerUnitPerHour: algorithmsTable.basePricePerUnitPerHour,
      rigCount: sql<string>`COUNT(${rigsTable.id}) FILTER (WHERE ${rigsTable.status} = 'available')`,
      totalHashrate: sql<string>`COALESCE(SUM(${rigsTable.hashrate}) FILTER (WHERE ${rigsTable.status} = 'available'), 0)`,
    })
    .from(algorithmsTable)
    .leftJoin(
      rigsTable,
      and(
        eq(rigsTable.algorithmId, algorithmsTable.id),
        eq(rigsTable.approvalStatus, "approved"),
      ),
    )
    .groupBy(algorithmsTable.id)
    .orderBy(desc(sql`COUNT(${rigsTable.id}) FILTER (WHERE ${rigsTable.status} = 'available')`));

  const algorithmsOnline = breakdown.filter(
    (b) => Number(b.rigCount) > 0,
  ).length;

  const topRigsRaw = await db
    .select({
      id: rigsTable.id,
      name: rigsTable.name,
      ownerId: rigsTable.ownerId,
      ownerDisplayName: usersTable.displayName,
      algorithmId: algorithmsTable.id,
      algorithmName: algorithmsTable.name,
      algorithmUnit: algorithmsTable.unit,
      hashrate: rigsTable.hashrate,
      basePricePerUnitPerHour: algorithmsTable.basePricePerUnitPerHour,
      minRentalHours: rigsTable.minRentalHours,
      maxRentalHours: rigsTable.maxRentalHours,
      status: rigsTable.status,
      createdAt: rigsTable.createdAt,
      averageRating: sql<string | null>`AVG(${reviewsTable.rating})`,
      reviewCount: sql<string>`COUNT(${reviewsTable.id})`,
    })
    .from(rigsTable)
    .innerJoin(usersTable, eq(usersTable.id, rigsTable.ownerId))
    .innerJoin(algorithmsTable, eq(algorithmsTable.id, rigsTable.algorithmId))
    .leftJoin(reviewsTable, eq(reviewsTable.rigId, rigsTable.id))
    .where(
      and(
        eq(rigsTable.status, "available"),
        eq(rigsTable.approvalStatus, "approved"),
      ),
    )
    .groupBy(rigsTable.id, usersTable.id, algorithmsTable.id)
    .orderBy(desc(rigsTable.hashrate))
    .limit(6);

  const data = GetMarketplaceSummaryResponse.parse({
    availableRigs: Number(counts?.availableRigs ?? 0),
    activeRentals: Number(activeRentalRow?.activeRentals ?? 0),
    totalLessors: Number(userCounts?.totalLessors ?? 0),
    totalRenters: Number(renterCounts?.totalRenters ?? 0),
    algorithmsOnline,
    breakdown: breakdown.map((b) => ({
      algorithmId: b.algorithmId,
      algorithmName: b.algorithmName,
      unit: b.unit,
      rigCount: Number(b.rigCount),
      totalHashrate: toNum(b.totalHashrate),
      averagePricePerUnitPerHour:
        toNum(b.basePricePerUnitPerHour) * renterMultiplier,
    })),
    topRigs: topRigsRaw.map((r) => ({
      id: r.id,
      name: r.name,
      ownerId: r.ownerId,
      ownerDisplayName: r.ownerDisplayName,
      algorithmId: r.algorithmId,
      algorithmName: r.algorithmName,
      algorithmUnit: r.algorithmUnit,
      hashrate: toNum(r.hashrate),
      pricePerUnitPerHour:
        toNum(r.basePricePerUnitPerHour) * renterMultiplier,
      minRentalHours: r.minRentalHours,
      maxRentalHours: r.maxRentalHours,
      status: r.status,
      approvalStatus: "approved" as const,
      averageRating:
        r.averageRating == null ? null : Number(toNum(r.averageRating).toFixed(2)),
      reviewCount: Number(r.reviewCount),
      createdAt: r.createdAt.toISOString(),
    })),
  });

  res.json(data);
});

export default router;
