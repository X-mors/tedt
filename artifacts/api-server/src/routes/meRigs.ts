import { Router, type IRouter } from "express";
import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import {
  db,
  rigsTable,
  algorithmsTable,
  usersTable,
  reviewsTable,
  rentalsTable,
  rigHashSamplesTable,
} from "@workspace/db";
import {
  CreateRigBody,
  GetMyRigResponse,
  ListMyRigsResponse,
  UpdateMyRigBody,
  UpdateMyRigResponse,
  GetMyRigLiveResponse,
  GetMyRigStatsResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../lib/auth";
import { getCommission } from "../lib/commission";
import { toNum, toUsdString, unitMultiplier } from "../lib/money";
import { proxyState } from "../lib/stratum/state";
import { randomBytes } from "node:crypto";

const PROXY_HOST = process.env["STRATUM_PROXY_HOST"] ?? "proxy.rigmarket.dev";
const PROXY_PORT = process.env["STRATUM_PROXY_PORT"] ?? "3333";

function slugifyRigName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24) || "rig";
}

async function uniqueStratumName(ownerId: number, base: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = attempt === 0 ? base : `${base.slice(0, 21)}-${attempt + 1}`;
    const [existing] = await db
      .select({ id: rigsTable.id })
      .from(rigsTable)
      .where(and(eq(rigsTable.ownerId, ownerId), eq(rigsTable.stratumName, candidate)));
    if (!existing) return candidate;
  }
  return `${base.slice(0, 18)}-${randomBytes(3).toString("hex")}`;
}

function ownerStratumFields(
  stratumUsername: string | null,
  stratumName: string | null,
) {
  const worker =
    stratumUsername && stratumName
      ? `${stratumUsername}.${stratumName}`
      : null;
  // Proxy accepts any password for {username}.{rigname} auth — we no longer
  // surface or rely on the legacy per-user stratumToken. The constant "x" is
  // the conventional Stratum placeholder password.
  return {
    ownerStratumUrl: `stratum+tcp://${PROXY_HOST}:${PROXY_PORT}`,
    ownerWorker: worker,
    ownerPassword: worker ? "x" : null,
  };
}

const router: IRouter = Router();

router.use(requireAuth);

async function selectMyRigs(ownerId: number) {
  const commission = await getCommission();
  const renterMultiplier = 1 + commission.renterFeePct / 100;

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
      stratumHost: rigsTable.stratumHost,
      stratumPort: rigsTable.stratumPort,
      stratumName: rigsTable.stratumName,
      createdAt: rigsTable.createdAt,
      averageRating: sql<string | null>`AVG(${reviewsTable.rating})`,
      reviewCount: sql<string>`COUNT(${reviewsTable.id})`,
    })
    .from(rigsTable)
    .innerJoin(usersTable, eq(usersTable.id, rigsTable.ownerId))
    .innerJoin(algorithmsTable, eq(algorithmsTable.id, rigsTable.algorithmId))
    .leftJoin(reviewsTable, eq(reviewsTable.rigId, rigsTable.id))
    .where(eq(rigsTable.ownerId, ownerId))
    .groupBy(rigsTable.id, usersTable.id, algorithmsTable.id)
    .orderBy(desc(rigsTable.createdAt));

  return rows.map((r) => {
    const ownerPerDay = r.pricePerUnitPerDay == null ? null : toNum(r.pricePerUnitPerDay);
    const effectivePerHour = ownerPerDay != null ? ownerPerDay / 24 : toNum(r.basePricePerUnitPerHour);
    return {
    id: r.id,
    name: r.name,
    ownerId: r.ownerId,
    ownerDisplayName: r.ownerDisplayName,
    algorithmId: r.algorithmId,
    algorithmName: r.algorithmName,
    algorithmUnit: r.algorithmUnit,
    hashrate: toNum(r.hashrate),
    pricePerUnitPerHour: effectivePerHour * renterMultiplier,
    pricePerUnitPerDay: ownerPerDay,
    minRentalHours: r.minRentalHours,
    maxRentalHours: r.maxRentalHours,
    status: r.status,
    approvalStatus: r.approvalStatus,
    approvalNote: r.approvalNote,
    isOnline: r.isOnline,
    hasFallbackPool: !!(r.stratumHost && r.stratumPort > 0),
    stratumName: r.stratumName ?? null,
    averageRating:
      r.averageRating == null
        ? null
        : Number(toNum(r.averageRating).toFixed(2)),
    reviewCount: Number(r.reviewCount),
    createdAt: r.createdAt.toISOString(),
  };
  });
}

async function selectMyRigDetail(ownerId: number, rigId: number) {
  const commission = await getCommission();
  const renterMultiplier = 1 + commission.renterFeePct / 100;

  const [row] = await db
    .select({
      id: rigsTable.id,
      name: rigsTable.name,
      description: rigsTable.description,
      ownerId: rigsTable.ownerId,
      ownerDisplayName: usersTable.displayName,
      ownerStratumUsername: usersTable.stratumUsername,
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
      region: rigsTable.region,
      isOnline: rigsTable.isOnline,
      stratumHost: rigsTable.stratumHost,
      stratumPort: rigsTable.stratumPort,
      stratumUser: rigsTable.stratumUser,
      stratumPassword: rigsTable.stratumPassword,
      stratumName: rigsTable.stratumName,
      createdAt: rigsTable.createdAt,
      averageRating: sql<string | null>`AVG(${reviewsTable.rating})`,
      reviewCount: sql<string>`COUNT(DISTINCT ${reviewsTable.id})`,
    })
    .from(rigsTable)
    .innerJoin(usersTable, eq(usersTable.id, rigsTable.ownerId))
    .innerJoin(algorithmsTable, eq(algorithmsTable.id, rigsTable.algorithmId))
    .leftJoin(reviewsTable, eq(reviewsTable.rigId, rigsTable.id))
    .where(and(eq(rigsTable.id, rigId), eq(rigsTable.ownerId, ownerId)))
    .groupBy(rigsTable.id, usersTable.id, algorithmsTable.id);

  if (!row) return null;

  const [rentals] = await db
    .select({ c: sql<string>`COUNT(*)` })
    .from(rentalsTable)
    .where(eq(rentalsTable.rigId, rigId));

  return {
    id: row.id,
    name: row.name,
    description: row.description ?? "",
    ownerId: row.ownerId,
    ownerDisplayName: row.ownerDisplayName,
    algorithmId: row.algorithmId,
    algorithmName: row.algorithmName,
    algorithmUnit: row.algorithmUnit,
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
    isOnline: row.isOnline,
    hasFallbackPool: !!(row.stratumHost && row.stratumPort > 0),
    fallbackPoolHost: row.stratumHost || null,
    fallbackPoolPort: row.stratumPort > 0 ? row.stratumPort : null,
    fallbackPoolUser: row.stratumUser || null,
    fallbackPoolPassword: row.stratumPassword || null,
    stratumName: row.stratumName ?? null,
    averageRating:
      row.averageRating == null
        ? null
        : Number(toNum(row.averageRating).toFixed(2)),
    reviewCount: Number(row.reviewCount),
    totalRentals: Number(rentals?.c ?? 0),
    createdAt: row.createdAt.toISOString(),
    fallbackPoolConnected:
      (proxyState.getFallbackPoolStatus(row.id) ??
        proxyState.getFallbackPoolStatusByOwner(row.ownerId))?.connected ?? null,
    fallbackPoolAuthFailed:
      (proxyState.getFallbackPoolStatus(row.id) ??
        proxyState.getFallbackPoolStatusByOwner(row.ownerId))?.authFailed ?? null,
    ...ownerStratumFields(
      row.ownerStratumUsername ?? null,
      row.stratumName ?? null,
    ),
  };
}

router.get("/me/rigs", async (req, res) => {
  const data = ListMyRigsResponse.parse(await selectMyRigs(req.currentUser!.id));
  res.json(data);
});

router.post("/me/rigs", async (req, res) => {
  const body = CreateRigBody.parse(req.body);
  if (body.maxRentalHours < body.minRentalHours) {
    res.status(400).json({ error: "maxRentalHours must be >= minRentalHours" });
    return;
  }
  const [algo] = await db
    .select()
    .from(algorithmsTable)
    .where(eq(algorithmsTable.id, body.algorithmId));
  if (!algo) {
    res.status(400).json({ error: "Unknown algorithm" });
    return;
  }
  // Auto-approve newly listed rigs — admin approval gate has been removed at
  // the user's request. Rigs become visible in the marketplace immediately.
  const proxyToken = randomBytes(32).toString("hex");
  const stratumName = await uniqueStratumName(
    req.currentUser!.id,
    slugifyRigName(body.name),
  );
  const [created] = await db
    .insert(rigsTable)
    .values({
      ownerId: req.currentUser!.id,
      algorithmId: body.algorithmId,
      name: body.name,
      description: body.description,
      hashrate: toUsdString(body.hashrate),
      ...(body.pricePerUnitPerDay != null && body.pricePerUnitPerDay > 0 && {
        pricePerUnitPerDay: toUsdString(body.pricePerUnitPerDay),
      }),
      minRentalHours: body.minRentalHours,
      maxRentalHours: body.maxRentalHours,
      region: body.region,
      approvalStatus: "approved",
      approvedAt: new Date(),
      proxyToken,
      stratumName,
      ...(body.fallbackPoolHost !== undefined && { stratumHost: body.fallbackPoolHost }),
      ...(body.fallbackPoolPort !== undefined && { stratumPort: body.fallbackPoolPort }),
      ...(body.fallbackPoolUser !== undefined && { stratumUser: body.fallbackPoolUser }),
      ...(body.fallbackPoolPassword !== undefined && { stratumPassword: body.fallbackPoolPassword }),
    })
    .returning({ id: rigsTable.id });

  // Promote renter -> owner the first time they list a rig.
  if (req.currentUser!.role === "renter") {
    await db
      .update(usersTable)
      .set({ role: "owner" })
      .where(eq(usersTable.id, req.currentUser!.id));
  }

  if (!created) {
    res.status(500).json({ error: "Failed to create rig" });
    return;
  }
  const detail = await selectMyRigDetail(req.currentUser!.id, created.id);
  if (!detail) {
    res.status(500).json({ error: "Failed to load created rig" });
    return;
  }
  // Spec says POST returns RigDetail (same shape as GET /me/rigs/:id), so reuse that schema.
  res.status(201).json(GetMyRigResponse.parse(detail));
});

router.get("/me/rigs/:id", async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const detail = await selectMyRigDetail(req.currentUser!.id, id);
  if (!detail) {
    res.status(404).json({ error: "Rig not found" });
    return;
  }
  res.json(GetMyRigResponse.parse(detail));
});

router.patch("/me/rigs/:id", async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  // Validate the request body and expose field-level errors to the client.
  const bodyResult = UpdateMyRigBody.safeParse(req.body);
  if (!bodyResult.success) {
    res.status(400).json({
      error: "Invalid request",
      details: bodyResult.error.issues,
    });
    return;
  }
  const body = bodyResult.data;

  const [existing] = await db
    .select()
    .from(rigsTable)
    .where(and(eq(rigsTable.id, id), eq(rigsTable.ownerId, req.currentUser!.id)));
  if (!existing) {
    res.status(404).json({ error: "Rig not found" });
    return;
  }

  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) patch["name"] = body.name;
  if (body.description !== undefined) patch["description"] = body.description;
  if (body.hashrate !== undefined) patch["hashrate"] = toUsdString(body.hashrate);
  // Owner-set custom price: null/0 → revert to algorithm default.
  if (body.pricePerUnitPerDay !== undefined) {
    patch["pricePerUnitPerDay"] =
      body.pricePerUnitPerDay == null || body.pricePerUnitPerDay <= 0
        ? null
        : toUsdString(body.pricePerUnitPerDay);
  }
  if (body.minRentalHours !== undefined)
    patch["minRentalHours"] = body.minRentalHours;
  if (body.maxRentalHours !== undefined)
    patch["maxRentalHours"] = body.maxRentalHours;
  if (body.region !== undefined) patch["region"] = body.region;
  if (body.status !== undefined) patch["status"] = body.status;
  // Fallback pool settings — empty string on host clears the whole pool config.
  if (body.fallbackPoolHost !== undefined) {
    patch["stratumHost"] = body.fallbackPoolHost;
    // If host is being cleared, reset port to 0 so hasFallbackPool becomes false.
    if (body.fallbackPoolHost === "") patch["stratumPort"] = 0;
  }
  if (body.fallbackPoolPort !== undefined)
    patch["stratumPort"] = body.fallbackPoolPort;
  if (body.fallbackPoolUser !== undefined)
    patch["stratumUser"] = body.fallbackPoolUser;
  if (body.fallbackPoolPassword !== undefined)
    patch["stratumPassword"] = body.fallbackPoolPassword;

  if (Object.keys(patch).length > 0) {
    await db.update(rigsTable).set(patch).where(eq(rigsTable.id, id));
  }

  // If fallback pool settings changed, hot-reload the upstream on any live
  // miner session that is currently idle (no active rental).
  const fallbackChanged =
    body.fallbackPoolHost !== undefined ||
    body.fallbackPoolPort !== undefined ||
    body.fallbackPoolUser !== undefined ||
    body.fallbackPoolPassword !== undefined;
  if (fallbackChanged) {
    const session = proxyState.getRigSession(id);
    if (session) void session.reloadFallbackPool();
  }

  const detail = await selectMyRigDetail(req.currentUser!.id, id);
  if (!detail) {
    res.status(404).json({ error: "Rig not found" });
    return;
  }

  // Validate the response shape; fall back to raw detail if it fails so the
  // client always gets a successful response after a successful DB update.
  const responseResult = UpdateMyRigResponse.safeParse(detail);
  if (!responseResult.success) {
    res.json(detail);
    return;
  }
  res.json(responseResult.data);
});

/**
 * Owner-side live telemetry for a rig. Returns share counts and connection
 * status for the rig's current session — works whether the miner is in
 * fallback mode (no rental) or routing for an active rental. Owners use this
 * to see their rig's hashrate when no one is renting.
 */
router.get("/me/rigs/:id/live", async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [rig] = await db
    .select({
      id: rigsTable.id,
      ownerId: rigsTable.ownerId,
      stratumHost: rigsTable.stratumHost,
      stratumPort: rigsTable.stratumPort,
      stratumUser: rigsTable.stratumUser,
    })
    .from(rigsTable)
    .where(and(eq(rigsTable.id, id), eq(rigsTable.ownerId, req.currentUser!.id)));
  if (!rig) {
    res.status(404).json({ error: "Rig not found" });
    return;
  }

  // Grace lookup: if the rig disconnected within the last 10 minutes, the
  // proxy still returns the last-known entry so the UI does not flap to
  // OFFLINE / 0 shares during a routine ASIC reconnect cycle. The `live`
  // flag distinguishes a current connection from a snapshot.
  const graced = proxyState.getRigEntryWithGrace(id);
  const entry = graced?.entry ?? null;
  const isLive = graced?.live ?? false;

  // When no rental is active, surface the configured fallback pool URL so the
  // owner can see where their idle hashrate is going.
  const rentalActive = entry?.rentalId != null;
  const fallbackUrl =
    rig.stratumHost && rig.stratumPort > 0
      ? `stratum+tcp://${rig.stratumHost}:${rig.stratumPort}`
      : null;

  // Current-hashrate fallback chain (resolves "owner stats freeze" bug):
  //   1. Rental window's rolling buffer when a rental is active.
  //   2. Per-rig fallback rolling buffer for idle mining (no rental).
  //   3. 0 only if the rig has produced no shares in the rolling-buffer
  //      window.
  let currentHashrate = 0;
  if (entry?.rentalId != null) {
    currentHashrate = proxyState.getLiveStats(entry.rentalId).effectiveHashrateH;
  } else {
    currentHashrate = proxyState.getFallbackHashrateH(id);
  }

  // Use the most recent share timestamp we know about — fallback buffer's
  // lastShareAt may be fresher than the entry's during fallback mining.
  const fallbackLastShare = proxyState.getFallbackLastShareAt(id);
  const effectiveLastShareAt =
    fallbackLastShare && (!entry?.lastShareAt || fallbackLastShare > entry.lastShareAt)
      ? fallbackLastShare
      : entry?.lastShareAt ?? null;

  const data = GetMyRigLiveResponse.parse({
    rigId: id,
    // Treat snapshot entries as "connected" for display — the rig was
    // mining moments ago and is almost certainly still mining.
    minerConnected: entry != null,
    upstreamConnected: isLive ? entry?.upstreamConnected ?? false : false,
    poolAuthFailed: isLive ? entry?.upstreamAuthFailed ?? false : false,
    poolUrl: rentalActive ? null : fallbackUrl,
    poolWorker: rentalActive ? null : (rig.stratumUser ?? null),
    sharesAccepted: entry?.sharesAccepted ?? 0,
    sharesRejected: entry?.sharesRejected ?? 0,
    currentHashrate,
    lastShareAt: effectiveLastShareAt ? effectiveLastShareAt.toISOString() : null,
    rentalActive,
  });
  res.json(data);
});

/**
 * Owner-side hashrate history for a rig. Returns up to 14 days of per-minute
 * samples (downsampled with bucket-averaging to MAX_CHART_POINTS) so the
 * owner can see continuous performance regardless of rental activity. Each
 * sample carries `hasRental` so the UI can shade rental periods.
 */
router.get("/me/rigs/:id/stats", async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [rig] = await db
    .select({
      id: rigsTable.id,
      ownerId: rigsTable.ownerId,
      hashrate: rigsTable.hashrate,
      algorithmUnit: algorithmsTable.unit,
    })
    .from(rigsTable)
    .innerJoin(algorithmsTable, eq(algorithmsTable.id, rigsTable.algorithmId))
    .where(and(eq(rigsTable.id, id), eq(rigsTable.ownerId, req.currentUser!.id)));
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

  // Bucket-average to keep chart payload bounded. Each output sample carries
  // hasRental=true if ANY raw sample in the bucket was inside a rental — this
  // keeps the yellow shading visually contiguous across rental boundaries.
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

  const data = GetMyRigStatsResponse.parse({
    rigId: id,
    algorithmUnit: rig.algorithmUnit,
    advertisedHashrate: toNum(rig.hashrate),
    retentionDays: RETENTION_DAYS,
    samples,
  });
  res.json(data);
});

router.delete("/me/rigs/:id", async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const result = await db
    .delete(rigsTable)
    .where(and(eq(rigsTable.id, id), eq(rigsTable.ownerId, req.currentUser!.id)))
    .returning({ id: rigsTable.id });
  if (result.length === 0) {
    res.status(404).json({ error: "Rig not found" });
    return;
  }
  // Drop any in-memory proxy state for the deleted rig (snapshot + fallback
  // buffer) so we don't keep stale records for a row that no longer exists.
  proxyState.forgetRig(id);
  res.status(204).end();
});

export default router;
