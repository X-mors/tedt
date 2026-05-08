import { Router, type IRouter } from "express";
import { and, asc, eq, gte, ilike, sql, desc } from "drizzle-orm";
import {
  db,
  rigsTable,
  algorithmsTable,
  usersTable,
  reviewsTable,
  rigHashSamplesTable,
} from "@workspace/db";
import {
  ListRigsResponse,
  GetRigResponse,
  ListRigReviewsResponse,
  GetRigStatsResponse,
} from "@workspace/api-zod";
import { getCommission } from "../lib/commission";
import { toNum, unitMultiplier } from "../lib/money";
import { proxyState } from "../lib/stratum/state";

const router: IRouter = Router();

router.get("/rigs", async (req, res) => {
  const algorithmIdRaw = req.query["algorithmId"];
  const status = req.query["status"];
  const sort = req.query["sort"];
  const search = req.query["search"];

  const commission = await getCommission();
  const renterMultiplier = 1 + commission.renterFeePct / 100;

  // Public marketplace only ever lists approved rigs that are currently
  // online/connected. Offline rigs are hidden from the public listing.
  const filters = [
    eq(rigsTable.approvalStatus, "approved"),
    eq(rigsTable.isOnline, true),
  ];
  if (algorithmIdRaw && !Number.isNaN(Number(algorithmIdRaw))) {
    filters.push(eq(rigsTable.algorithmId, Number(algorithmIdRaw)));
  }
  if (typeof status === "string" && status !== "") {
    filters.push(
      eq(rigsTable.status, status as "available" | "rented" | "offline" | "paused"),
    );
  }
  if (typeof search === "string" && search.trim() !== "") {
    filters.push(ilike(rigsTable.name, `%${search.trim()}%`));
  }

  const rows = await db
    .select({
      id: rigsTable.id,
      name: rigsTable.name,
      ownerId: rigsTable.ownerId,
      ownerDisplayName: usersTable.displayName,
      algorithmId: algorithmsTable.id,
      algorithmName: algorithmsTable.name,
      algorithmUnit: algorithmsTable.unit,
      basePricePerUnitPerHour: algorithmsTable.basePricePerUnitPerHour,
      pricePerUnitPerDay: rigsTable.pricePerUnitPerDay,
      hashrate: rigsTable.hashrate,
      minRentalHours: rigsTable.minRentalHours,
      maxRentalHours: rigsTable.maxRentalHours,
      status: rigsTable.status,
      approvalStatus: rigsTable.approvalStatus,
      approvalNote: rigsTable.approvalNote,
      isOnline: rigsTable.isOnline,
      createdAt: rigsTable.createdAt,
      averageRating: sql<string | null>`AVG(${reviewsTable.rating})`,
      reviewCount: sql<string>`COUNT(${reviewsTable.id})`,
    })
    .from(rigsTable)
    .innerJoin(usersTable, eq(usersTable.id, rigsTable.ownerId))
    .innerJoin(algorithmsTable, eq(algorithmsTable.id, rigsTable.algorithmId))
    .leftJoin(reviewsTable, eq(reviewsTable.rigId, rigsTable.id))
    .where(and(...filters))
    .groupBy(rigsTable.id, usersTable.id, algorithmsTable.id);

  // Effective per-hour base price: owner override (per-day / 24) wins over algorithm default.
  const effectiveBase = (r: { basePricePerUnitPerHour: string; pricePerUnitPerDay: string | null }) =>
    r.pricePerUnitPerDay != null
      ? toNum(r.pricePerUnitPerDay) / 24
      : toNum(r.basePricePerUnitPerHour);

  // Apply sort in memory because price depends on commission.
  const sortKey = typeof sort === "string" ? sort : "newest";
  const sorted = [...rows];
  switch (sortKey) {
    case "price_asc":
      sorted.sort((a, b) => effectiveBase(a) - effectiveBase(b));
      break;
    case "price_desc":
      sorted.sort((a, b) => effectiveBase(b) - effectiveBase(a));
      break;
    case "hashrate_desc":
      sorted.sort((a, b) => toNum(b.hashrate) - toNum(a.hashrate));
      break;
    case "rating_desc":
      sorted.sort(
        (a, b) =>
          (a.averageRating == null ? -1 : toNum(a.averageRating)) <
          (b.averageRating == null ? -1 : toNum(b.averageRating))
            ? 1
            : -1,
      );
      break;
    default:
      sorted.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  const data = ListRigsResponse.parse(
    sorted.map((r) => ({
      id: r.id,
      name: r.name,
      ownerId: r.ownerId,
      ownerDisplayName: r.ownerDisplayName,
      algorithmId: r.algorithmId,
      algorithmName: r.algorithmName,
      algorithmUnit: r.algorithmUnit,
      hashrate: toNum(r.hashrate),
      pricePerUnitPerHour: effectiveBase(r) * renterMultiplier,
      pricePerUnitPerDay: r.pricePerUnitPerDay == null ? null : toNum(r.pricePerUnitPerDay),
      minRentalHours: r.minRentalHours,
      maxRentalHours: r.maxRentalHours,
      status: r.status,
      approvalStatus: r.approvalStatus,
      approvalNote: r.approvalNote,
      isOnline: r.isOnline,
      hasFallbackPool: false,
      stratumName: null,
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
      algorithmSlug: algorithmsTable.slug,
      basePricePerUnitPerHour: algorithmsTable.basePricePerUnitPerHour,
      pricePerUnitPerDay: rigsTable.pricePerUnitPerDay,
      hashrate: rigsTable.hashrate,
      minRentalHours: rigsTable.minRentalHours,
      maxRentalHours: rigsTable.maxRentalHours,
      status: rigsTable.status,
      approvalStatus: rigsTable.approvalStatus,
      approvalNote: rigsTable.approvalNote,
      region: rigsTable.region,
      isOnline: rigsTable.isOnline,
      createdAt: rigsTable.createdAt,
      averageRating: sql<string | null>`(SELECT AVG(rating) FROM reviews WHERE rig_id = ${rigsTable.id})`,
      reviewCount: sql<string>`(SELECT COUNT(*) FROM reviews WHERE rig_id = ${rigsTable.id})`,
      totalRentals: sql<string>`(SELECT COUNT(*) FROM rentals WHERE rig_id = ${rigsTable.id})`,
    })
    .from(rigsTable)
    .innerJoin(usersTable, eq(usersTable.id, rigsTable.ownerId))
    .innerJoin(algorithmsTable, eq(algorithmsTable.id, rigsTable.algorithmId))
    .where(
      and(
        eq(rigsTable.id, id),
        eq(rigsTable.approvalStatus, "approved"),
      ),
    );

  if (!row) {
    res.status(404).json({ error: "Rig not found" });
    return;
  }

  const data = GetRigResponse.parse({
    id: row.id,
    name: row.name,
    description: row.description ?? "",
    ownerId: row.ownerId,
    ownerDisplayName: row.ownerDisplayName,
    algorithmId: row.algorithmId,
    algorithmName: row.algorithmName,
    algorithmUnit: row.algorithmUnit,
    algorithmSlug: row.algorithmSlug,
    hashrate: toNum(row.hashrate),
    pricePerUnitPerHour:
      (row.pricePerUnitPerDay != null
        ? toNum(row.pricePerUnitPerDay) / 24
        : toNum(row.basePricePerUnitPerHour)) * renterMultiplier,
    pricePerUnitPerDay:
      row.pricePerUnitPerDay == null ? null : toNum(row.pricePerUnitPerDay),
    minRentalHours: row.minRentalHours,
    maxRentalHours: row.maxRentalHours,
    status: row.status,
    approvalStatus: row.approvalStatus,
    approvalNote: row.approvalNote,
    region: row.region,
    averageRating:
      row.averageRating == null
        ? null
        : Number(toNum(row.averageRating).toFixed(2)),
    reviewCount: Number(row.reviewCount),
    totalRentals: Number(row.totalRentals),
    // Public endpoint does not expose owner-private stratum credentials or fallback pool config.
    ownerStratumUrl: null,
    ownerWorker: null,
    ownerPassword: null,
    isOnline: row.isOnline,
    hasFallbackPool: false,
    fallbackPoolHost: null,
    fallbackPoolPort: null,
    fallbackPoolUser: null,
    fallbackPoolPassword: null,
    stratumName: null,
    createdAt: row.createdAt.toISOString(),
  });

  res.json(data);
});

/**
 * Public hashrate history for a rig. Returns up to 14 days of bucket-averaged
 * samples with `hasRental` flags so visitors (logged in or not) can see the
 * rig's recent performance and rental activity. Mirrors the owner-only
 * `/me/rigs/:id/stats` endpoint shape but without ownership checks.
 */
router.get("/rigs/:id/stats", async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [rig] = await db
    .select({
      id: rigsTable.id,
      hashrate: rigsTable.hashrate,
      algorithmUnit: algorithmsTable.unit,
    })
    .from(rigsTable)
    .innerJoin(algorithmsTable, eq(algorithmsTable.id, rigsTable.algorithmId))
    .where(
      and(
        eq(rigsTable.id, id),
        eq(rigsTable.approvalStatus, "approved"),
      ),
    );
  if (!rig) {
    res.status(404).json({ error: "Rig not found" });
    return;
  }

  const RETENTION_DAYS = 14;
  const since = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const dbSamples = await db
    .select({
      sampledAt: rigHashSamplesTable.sampledAt,
      effectiveHashrateH: rigHashSamplesTable.effectiveHashrateH,
      rentalId: rigHashSamplesTable.rentalId,
    })
    .from(rigHashSamplesTable)
    .where(
      and(
        eq(rigHashSamplesTable.rigId, id),
        gte(rigHashSamplesTable.sampledAt, since),
      ),
    )
    .orderBy(asc(rigHashSamplesTable.sampledAt));

  const algMultiplier = unitMultiplier(rig.algorithmUnit);

  const MAX_CHART_POINTS = 720;
  let samples: { timestamp: string; hashrate: number; hasRental: boolean }[];
  if (dbSamples.length <= MAX_CHART_POINTS) {
    samples = dbSamples.map((s) => ({
      timestamp: s.sampledAt.toISOString(),
      hashrate: toNum(s.effectiveHashrateH ?? "0") / algMultiplier,
      hasRental: s.rentalId != null,
    }));
  } else {
    const bucketSize = Math.ceil(dbSamples.length / MAX_CHART_POINTS);
    samples = [];
    for (let i = 0; i < dbSamples.length; i += bucketSize) {
      const bucket = dbSamples.slice(i, i + bucketSize);
      const sum = bucket.reduce(
        (s, x) => s + toNum(x.effectiveHashrateH ?? "0"),
        0,
      );
      samples.push({
        timestamp: bucket[Math.floor(bucket.length / 2)]!.sampledAt.toISOString(),
        hashrate: sum / bucket.length / algMultiplier,
        hasRental: bucket.some((x) => x.rentalId != null),
      });
    }
  }

  const data = GetRigStatsResponse.parse({
    rigId: id,
    algorithmUnit: rig.algorithmUnit,
    advertisedHashrate: toNum(rig.hashrate),
    retentionDays: RETENTION_DAYS,
    samples,
  });
  res.json(data);
});

/**
 * Public live telemetry for a rig. Returns current hashrate and share
 * difficulty so visitors can see whether a rig is actively hashing.
 * No auth required — no sensitive pool or renter data is exposed.
 */
router.get("/rigs/:id/live", async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [rig] = await db
    .select({
      id: rigsTable.id,
      isOnline: rigsTable.isOnline,
      algorithmUnit: algorithmsTable.unit,
    })
    .from(rigsTable)
    .innerJoin(algorithmsTable, eq(algorithmsTable.id, rigsTable.algorithmId))
    .where(and(eq(rigsTable.id, id), eq(rigsTable.approvalStatus, "approved")));
  if (!rig) {
    res.status(404).json({ error: "Rig not found" });
    return;
  }

  const entry = proxyState.getRigEntry(id);
  const rentalId = entry?.rentalId ?? null;
  let currentHashrateH = 0;
  if (rentalId != null) {
    currentHashrateH = proxyState.getLiveStats(rentalId).effectiveHashrateH;
  } else {
    currentHashrateH = proxyState.getFallbackHashrateH(id);
  }
  const currentDifficulty = entry?.currentDifficulty ?? 1;
  const algMultiplier = unitMultiplier(rig.algorithmUnit);

  res.json({
    rigId: id,
    isOnline: rig.isOnline,
    algorithmUnit: rig.algorithmUnit,
    currentHashrateH,
    currentHashrate: currentHashrateH / algMultiplier,
    currentDifficulty,
  });
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

export default router;
