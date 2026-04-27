import { Router, type IRouter } from "express";
import { and, eq, ilike, sql, desc, asc } from "drizzle-orm";
import {
  db,
  rigsTable,
  algorithmsTable,
  usersTable,
  reviewsTable,
} from "@workspace/db";
import {
  ListRigsResponse,
  GetRigResponse,
  ListRigReviewsResponse,
} from "@workspace/api-zod";
import { getCommission } from "../lib/commission";
import { toNum } from "../lib/money";

const router: IRouter = Router();

router.get("/rigs", async (req, res) => {
  const algorithmIdRaw = req.query["algorithmId"];
  const status = req.query["status"];
  const sort = req.query["sort"];
  const search = req.query["search"];

  const commission = await getCommission();
  const renterMultiplier = 1 + commission.renterFeePct / 100;

  const filters = [];
  if (algorithmIdRaw && !Number.isNaN(Number(algorithmIdRaw))) {
    filters.push(eq(rigsTable.algorithmId, Number(algorithmIdRaw)));
  }
  if (typeof status === "string" && status !== "") {
    filters.push(eq(rigsTable.status, status as "available" | "rented" | "offline"));
  }
  if (typeof search === "string" && search.trim() !== "") {
    filters.push(ilike(rigsTable.name, `%${search.trim()}%`));
  }

  const baseQuery = db
    .select({
      id: rigsTable.id,
      name: rigsTable.name,
      ownerId: rigsTable.ownerId,
      ownerDisplayName: usersTable.displayName,
      algorithmId: algorithmsTable.id,
      algorithmName: algorithmsTable.name,
      algorithmUnit: algorithmsTable.unit,
      basePricePerUnitPerHour: algorithmsTable.basePricePerUnitPerHour,
      hashrate: rigsTable.hashrate,
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
    .where(filters.length ? and(...filters) : undefined)
    .groupBy(rigsTable.id, usersTable.id, algorithmsTable.id);

  let rows = await baseQuery;

  // Apply sort in memory because price depends on commission.
  const sortKey = typeof sort === "string" ? sort : "newest";
  switch (sortKey) {
    case "price_asc":
      rows = rows.sort(
        (a, b) =>
          toNum(a.basePricePerUnitPerHour) - toNum(b.basePricePerUnitPerHour),
      );
      break;
    case "price_desc":
      rows = rows.sort(
        (a, b) =>
          toNum(b.basePricePerUnitPerHour) - toNum(a.basePricePerUnitPerHour),
      );
      break;
    case "hashrate_desc":
      rows = rows.sort((a, b) => toNum(b.hashrate) - toNum(a.hashrate));
      break;
    default:
      rows = rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  const data = ListRigsResponse.parse(
    rows.map((r) => ({
      id: r.id,
      name: r.name,
      ownerId: r.ownerId,
      ownerDisplayName: r.ownerDisplayName,
      algorithmId: r.algorithmId,
      algorithmName: r.algorithmName,
      algorithmUnit: r.algorithmUnit,
      hashrate: toNum(r.hashrate),
      pricePerUnitPerHour: toNum(r.basePricePerUnitPerHour) * renterMultiplier,
      minRentalHours: r.minRentalHours,
      maxRentalHours: r.maxRentalHours,
      status: r.status,
      averageRating:
        r.averageRating == null
          ? null
          : Number(toNum(r.averageRating).toFixed(2)),
      reviewCount: Number(r.reviewCount),
      createdAt: r.createdAt.toISOString(),
    })),
  );

  res.json(data);
});

router.get("/rigs/:id", async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const commission = await getCommission();
  const renterMultiplier = 1 + commission.renterFeePct / 100;

  const [row] = await db
    .select({
      id: rigsTable.id,
      name: rigsTable.name,
      description: rigsTable.description,
      ownerId: rigsTable.ownerId,
      ownerDisplayName: usersTable.displayName,
      algorithmId: algorithmsTable.id,
      algorithmName: algorithmsTable.name,
      algorithmUnit: algorithmsTable.unit,
      basePricePerUnitPerHour: algorithmsTable.basePricePerUnitPerHour,
      hashrate: rigsTable.hashrate,
      minRentalHours: rigsTable.minRentalHours,
      maxRentalHours: rigsTable.maxRentalHours,
      status: rigsTable.status,
      region: rigsTable.region,
      createdAt: rigsTable.createdAt,
      averageRating: sql<string | null>`(SELECT AVG(rating) FROM reviews WHERE rig_id = ${rigsTable.id})`,
      reviewCount: sql<string>`(SELECT COUNT(*) FROM reviews WHERE rig_id = ${rigsTable.id})`,
      totalRentals: sql<string>`(SELECT COUNT(*) FROM rentals WHERE rig_id = ${rigsTable.id})`,
    })
    .from(rigsTable)
    .innerJoin(usersTable, eq(usersTable.id, rigsTable.ownerId))
    .innerJoin(algorithmsTable, eq(algorithmsTable.id, rigsTable.algorithmId))
    .where(eq(rigsTable.id, id));

  if (!row) {
    res.status(404).json({ error: "Rig not found" });
    return;
  }

  const data = GetRigResponse.parse({
    id: row.id,
    name: row.name,
    description: row.description,
    ownerId: row.ownerId,
    ownerDisplayName: row.ownerDisplayName,
    algorithmId: row.algorithmId,
    algorithmName: row.algorithmName,
    algorithmUnit: row.algorithmUnit,
    hashrate: toNum(row.hashrate),
    pricePerUnitPerHour:
      toNum(row.basePricePerUnitPerHour) * renterMultiplier,
    minRentalHours: row.minRentalHours,
    maxRentalHours: row.maxRentalHours,
    status: row.status,
    region: row.region,
    averageRating:
      row.averageRating == null
        ? null
        : Number(toNum(row.averageRating).toFixed(2)),
    reviewCount: Number(row.reviewCount),
    totalRentals: Number(row.totalRentals),
    createdAt: row.createdAt.toISOString(),
  });

  res.json(data);
});

router.get("/rigs/:id/reviews", async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const rows = await db
    .select({
      id: reviewsTable.id,
      rigId: reviewsTable.rigId,
      rentalId: reviewsTable.rentalId,
      renterDisplayName: usersTable.displayName,
      rating: reviewsTable.rating,
      body: reviewsTable.body,
      createdAt: reviewsTable.createdAt,
    })
    .from(reviewsTable)
    .innerJoin(usersTable, eq(usersTable.id, reviewsTable.renterId))
    .where(eq(reviewsTable.rigId, id))
    .orderBy(desc(reviewsTable.createdAt));

  const data = ListRigReviewsResponse.parse(
    rows.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
    })),
  );
  res.json(data);
});

void asc;

export default router;
