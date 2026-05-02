import { Router, type IRouter } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  rigsTable,
  algorithmsTable,
  usersTable,
  reviewsTable,
  rentalsTable,
} from "@workspace/db";
import {
  CreateRigBody,
  GetMyRigResponse,
  ListMyRigsResponse,
  UpdateMyRigBody,
  UpdateMyRigResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../lib/auth";
import { getCommission } from "../lib/commission";
import { toNum, toUsdString } from "../lib/money";
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

  return rows.map((r) => ({
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
  }));
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
    pricePerUnitPerHour: toNum(row.basePricePerUnitPerHour) * renterMultiplier,
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
    fallbackPoolConnected: proxyState.getFallbackPoolStatus(row.id)?.connected ?? null,
    fallbackPoolAuthFailed: proxyState.getFallbackPoolStatus(row.id)?.authFailed ?? null,
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
  // Newly listed rigs always start in `pending` and require admin approval.
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
      minRentalHours: body.minRentalHours,
      maxRentalHours: body.maxRentalHours,
      region: body.region,
      approvalStatus: "pending",
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
  const body = UpdateMyRigBody.parse(req.body);

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
  if (body.minRentalHours !== undefined)
    patch["minRentalHours"] = body.minRentalHours;
  if (body.maxRentalHours !== undefined)
    patch["maxRentalHours"] = body.maxRentalHours;
  if (body.region !== undefined) patch["region"] = body.region;
  if (body.status !== undefined) patch["status"] = body.status;
  // Fallback pool settings — empty string clears the pool config.
  if (body.fallbackPoolHost !== undefined)
    patch["stratumHost"] = body.fallbackPoolHost;
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
  res.json(UpdateMyRigResponse.parse(detail));
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
  res.status(204).end();
});

export default router;
