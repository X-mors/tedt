import { Router, type IRouter } from "express";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import {
  db,
  rigsTable,
  algorithmsTable,
  usersTable,
  rentalsTable,
  walletTransactionsTable,
  reviewsTable,
  rentalHashSamplesTable,
} from "@workspace/db";
import { proxyState } from "../lib/stratum/state";
import { flushAndRemoveRentalWindow } from "../lib/stratum/persistence";
import { logger } from "../lib/logger";
import {
  CreateRentalBody,
  CreateRentalQuoteBody,
  CreateRentalQuoteResponse,
  GetRentalResponse,
  GetRentalStatsResponse,
  CancelRentalResponse,
  CreateRentalReviewBody,
  ListRigReviewsResponseItem,
  ListMyRentalsResponse,
  ListLessorRentalsResponse,
  SwitchRentalPoolBody,
  SwitchRentalPoolResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../lib/auth";
import { getCommission } from "../lib/commission";
import { round2, round6, toNum, toUsdString, unitMultiplier, computeDeliveryRatio } from "../lib/money";
import { settleExpiredRentals } from "../lib/settlement";
import { validatePoolUrl } from "../lib/ssrf";
import { randomBytes } from "node:crypto";

const router: IRouter = Router();

/**
 * Display-stability constants for rental live/stats endpoints.
 *
 * Real ASIC firmwares routinely close and re-open the stratum TCP socket
 * (every 1-2 minutes) for keepalive / job rotation reasons even while mining
 * normally. The raw in-memory state flips minerConnected=false and
 * effectiveHashrateH=0 during these brief gaps, which makes the renter UI
 * flap to "OFFLINE / 0 H/s" even though the rental is healthy.
 *
 * To smooth this for display only, we:
 *  - keep the connection flags "true" if a share was received within
 *    SOFT_CONNECT_GRACE_MS (covers normal reconnect cycles);
 *  - fall back to the average of recent DB samples (one per minute,
 *    persisted by the stratum flush loop) when the live window happens
 *    to be empty.
 *
 * These constants ONLY affect the values returned by /live and /stats.
 * The underlying proxy state, sample persistence, settlement math, and
 * low-delivery auto-cancel logic are unchanged.
 */
const SOFT_CONNECT_GRACE_MS = 15 * 60_000;
const RECENT_SAMPLE_WINDOW_MS = 30 * 60_000;

/**
 * Fallback hashrate chain when the live rolling buffer is empty (rig in a
 * brief reconnect gap or no recent shares). Returns the most recent
 * non-zero DB sample within the lookback window — picking the latest known
 * value is far more representative than averaging across silent periods,
 * which dragged the displayed hashrate to zero whenever the rig stuttered.
 *
 * Returns 0 only when there is no non-zero sample in the lookback window —
 * the caller should then fall back to the cumulative deliveredHashrateAvg.
 */
async function getMostRecentNonZeroHashrateH(rentalId: number): Promise<number> {
  const cutoff = new Date(Date.now() - RECENT_SAMPLE_WINDOW_MS);
  const rows = await db
    .select({ effectiveHashrateH: rentalHashSamplesTable.effectiveHashrateH })
    .from(rentalHashSamplesTable)
    .where(
      and(
        eq(rentalHashSamplesTable.rentalId, rentalId),
        gte(rentalHashSamplesTable.sampledAt, cutoff),
      ),
    )
    .orderBy(desc(rentalHashSamplesTable.sampledAt))
    .limit(60);
  for (const r of rows) {
    const h = toNum(r.effectiveHashrateH ?? "0");
    if (h > 0) return h;
  }
  return 0;
}

function withinGrace(lastShareAt: Date | null): boolean {
  return (
    lastShareAt != null &&
    Date.now() - lastShareAt.getTime() < SOFT_CONNECT_GRACE_MS
  );
}

function priceForRental(opts: {
  hashrate: number;
  hours: number;
  basePrice: number;
  renterFeePct: number;
  ownerFeePct: number;
}) {
  const { hashrate, hours, basePrice, renterFeePct, ownerFeePct } = opts;
  const baseSubtotal = hashrate * basePrice * hours;
  const renterFee = baseSubtotal * (renterFeePct / 100);
  const renterTotal = baseSubtotal + renterFee;
  const ownerFee = baseSubtotal * (ownerFeePct / 100);
  const ownerEarnings = baseSubtotal - ownerFee;
  const platformFee = renterFee + ownerFee;
  return {
    baseSubtotalUsd: round2(baseSubtotal),
    renterFeeUsd: round2(renterFee),
    renterTotalUsd: round2(renterTotal),
    ownerEarningsUsd: round2(ownerEarnings),
    platformFeeUsd: round2(platformFee),
  };
}

function buildProxyCreds() {
  // STRATUM_HOST should be set on the VPS (e.g. livehashrate.com).
  // Falls back to REPLIT_DEV_DOMAIN for local dev, then a safe placeholder.
  const host =
    process.env["STRATUM_HOST"] ??
    process.env["REPLIT_DEV_DOMAIN"] ??
    "livehashrate.com";
  const port = process.env["STRATUM_PORT"] ?? "3333";
  return {
    stratumProxyUrl: `stratum+tcp://${host}:${port}`,
    proxyWorker: `worker.${randomBytes(4).toString("hex")}`,
    proxyPassword: randomBytes(8).toString("hex"),
  };
}

router.use(requireAuth);

router.post("/rentals/quote", async (req, res) => {
  const body = CreateRentalQuoteBody.parse(req.body);
  const [rigRow] = await db
    .select({
      id: rigsTable.id,
      hashrate: rigsTable.hashrate,
      minRentalHours: rigsTable.minRentalHours,
      maxRentalHours: rigsTable.maxRentalHours,
      status: rigsTable.status,
      basePrice: algorithmsTable.basePricePerUnitPerHour,
      algorithmUnit: algorithmsTable.unit,
    })
    .from(rigsTable)
    .innerJoin(algorithmsTable, eq(algorithmsTable.id, rigsTable.algorithmId))
    .where(eq(rigsTable.id, body.rigId));

  if (!rigRow) {
    res.status(404).json({ error: "Rig not found" });
    return;
  }
  const commission = await getCommission();
  const hashrate = toNum(rigRow.hashrate);
  const basePrice = toNum(rigRow.basePrice);
  const pricing = priceForRental({
    hashrate,
    hours: body.hours,
    basePrice,
    renterFeePct: commission.renterFeePct,
    ownerFeePct: commission.ownerFeePct,
  });

  const data = CreateRentalQuoteResponse.parse({
    rigId: rigRow.id,
    hours: body.hours,
    hashrate,
    algorithmUnit: rigRow.algorithmUnit,
    basePricePerUnitPerHour: basePrice,
    renterFeePct: commission.renterFeePct,
    ownerFeePct: commission.ownerFeePct,
    ...pricing,
  });
  res.json(data);
});

router.post("/rentals", async (req, res) => {
  const body = CreateRentalBody.parse(req.body);

  // SSRF guard — only stratum+tcp:// or stratum:// (plain TCP); no TLS variant
  // since the proxy speaks plain TCP only. Block private/loopback/reserved hosts.
  {
    const ssrfError = await validatePoolUrl(body.poolUrl);
    if (ssrfError) {
      res.status(400).json({ error: ssrfError });
      return;
    }
  }

  // Settle anything expired so a freshly-finished rig is back to "available"
  // and an attempted rebooking succeeds.
  await settleExpiredRentals();

  const [rigRow] = await db
    .select({
      id: rigsTable.id,
      ownerId: rigsTable.ownerId,
      hashrate: rigsTable.hashrate,
      minRentalHours: rigsTable.minRentalHours,
      maxRentalHours: rigsTable.maxRentalHours,
      status: rigsTable.status,
      approvalStatus: rigsTable.approvalStatus,
      lastSeenAt: rigsTable.lastSeenAt,
      basePrice: algorithmsTable.basePricePerUnitPerHour,
    })
    .from(rigsTable)
    .innerJoin(algorithmsTable, eq(algorithmsTable.id, rigsTable.algorithmId))
    .where(eq(rigsTable.id, body.rigId));

  if (!rigRow) {
    res.status(404).json({ error: "Rig not found" });
    return;
  }
  if (rigRow.approvalStatus !== "approved") {
    res.status(400).json({ error: "Rig is not approved for rental" });
    return;
  }
  if (rigRow.ownerId === req.currentUser!.id) {
    res.status(400).json({ error: "Cannot rent your own rig" });
    return;
  }

  // Effective availability check: rig.status is the persisted DB column
  // (refreshed every 5 min by the online-sync interval), but the proxy
  // knows the truth right now. Three signals make a rig rentable:
  //   1. status === "available" (DB says ready), OR
  //   2. owner has a live proxy session right now (miner is connected), OR
  //   3. lastSeenAt is recent (≤5 min) — covers stratum-proxy aggregators
  //      that open/close TCP connections every ~30-120s, so getAnySessionForOwner
  //      sees null in the gaps even though the rig is actively mining.
  // "rented" and "paused" still block (handled in the tx below).
  const ownerHasLiveSession =
    proxyState.getAnySessionForOwner(rigRow.ownerId) != null;
  const recentlySeen =
    rigRow.lastSeenAt != null &&
    Date.now() - new Date(rigRow.lastSeenAt).getTime() < 5 * 60 * 1000;
  const isMineable =
    rigRow.status === "available" ||
    (rigRow.status !== "rented" &&
      rigRow.status !== "paused" &&
      (ownerHasLiveSession || recentlySeen));
  if (!isMineable) {
    res.status(400).json({ error: "Rig is not available" });
    return;
  }
  if (body.hours < rigRow.minRentalHours || body.hours > rigRow.maxRentalHours) {
    res.status(400).json({
      error: `Rental must be between ${rigRow.minRentalHours} and ${rigRow.maxRentalHours} hours`,
    });
    return;
  }

  const commission = await getCommission();
  const hashrate = toNum(rigRow.hashrate);
  const basePrice = toNum(rigRow.basePrice);
  const pricing = priceForRental({
    hashrate,
    hours: body.hours,
    basePrice,
    renterFeePct: commission.renterFeePct,
    ownerFeePct: commission.ownerFeePct,
  });

  const renterTotalStr = toUsdString(pricing.renterTotalUsd);

  class TxError extends Error {
    constructor(public readonly code: "insufficient" | "unavailable" | "create") {
      super(code);
      this.name = "TxError";
    }
  }

  let rentalId: number;
  try {
    rentalId = await db.transaction(async (tx) => {
      // Atomic conditional debit — fails if the renter doesn't have funds at
      // the moment the UPDATE runs, regardless of stale snapshots in Express.
      const [debited] = await tx
        .update(usersTable)
        .set({
          balanceUsd: sql`${usersTable.balanceUsd} - ${renterTotalStr}`,
          totalSpentUsd: sql`${usersTable.totalSpentUsd} + ${renterTotalStr}`,
        })
        .where(
          sql`${usersTable.id} = ${req.currentUser!.id} AND ${usersTable.balanceUsd} >= ${renterTotalStr}`,
        )
        .returning({ balanceUsd: usersTable.balanceUsd });
      if (!debited) throw new TxError("insufficient");

      // Atomic rig reservation — fails if someone else just rented it.
      // Throwing here causes Drizzle to roll back the debit above.
      const [reserved] = await tx
        .update(rigsTable)
        .set({ status: "rented" })
        .where(
          // Accept any status except "rented"/"paused" — the pre-tx
          // isMineable check above already confirmed the rig is genuinely
          // mineable (live session or recent lastSeenAt). "rented" and
          // "paused" remain blocked, so race conditions can't double-rent
          // or override an owner's pause.
          sql`${rigsTable.id} = ${body.rigId} AND ${rigsTable.status} NOT IN ('rented', 'paused') AND ${rigsTable.approvalStatus} = 'approved'`,
        )
        .returning({ id: rigsTable.id });
      if (!reserved) throw new TxError("unavailable");

      const proxy = buildProxyCreds();
      const startedAt = new Date();
      const endsAt = new Date(startedAt.getTime() + body.hours * 3600 * 1000);

      const [rental] = await tx
        .insert(rentalsTable)
        .values({
          rigId: rigRow.id,
          renterId: req.currentUser!.id,
          ownerId: rigRow.ownerId,
          hours: body.hours,
          hashrate: toUsdString(hashrate),
          basePricePerUnitPerHour: toUsdString(basePrice),
          renterFeePct: commission.renterFeePct.toString(),
          ownerFeePct: commission.ownerFeePct.toString(),
          renterTotalUsd: renterTotalStr,
          ownerEarningsUsd: toUsdString(pricing.ownerEarningsUsd),
          platformFeeUsd: toUsdString(pricing.platformFeeUsd),
          status: "active",
          poolUrl: body.poolUrl,
          poolWorker: body.poolWorker,
          poolPassword: body.poolPassword ?? "x",
          stratumProxyUrl: proxy.stratumProxyUrl,
          proxyWorker: proxy.proxyWorker,
          proxyPassword: proxy.proxyPassword,
          startedAt,
          endsAt,
        })
        .returning();
      if (!rental) throw new TxError("create");

      await tx.insert(walletTransactionsTable).values({
        userId: req.currentUser!.id,
        type: "rental_charge",
        amountUsd: toUsdString(-pricing.renterTotalUsd),
        balanceAfterUsd: toUsdString(round6(toNum(debited.balanceUsd))),
        memo: `Rental #${rental.id} on rig ${rigRow.id}`,
        relatedRentalId: rental.id,
      });

      return rental.id;
    });
  } catch (err) {
    if (err instanceof TxError) {
      if (err.code === "insufficient") {
        res.status(402).json({
          error: `Insufficient balance. Need $${pricing.renterTotalUsd.toFixed(2)}.`,
        });
      } else if (err.code === "unavailable") {
        res.status(400).json({ error: "Rig is not available" });
      } else {
        res.status(500).json({ error: "Failed to create rental" });
      }
      return;
    }
    throw err;
  }

  const newRental = await loadRentalDetail(rentalId);

  // If the rig owner's miner is already connected to the proxy, start routing immediately.
  // Primary lookup: by the exact rigId stored in the session (happy path).
  // Fallback lookup: by ownerId — handles the case where the miner connected with a
  // stratumName that differs from the listed rig's stratumName (e.g. the rig was listed
  // under a different name and the proxy auto-created a shadow rig entry). In that
  // scenario the session is keyed under the shadow rig's ID, not body.rigId.
  const session =
    proxyState.getRigSession(body.rigId) ??
    proxyState.getAnySessionForOwner(rigRow.ownerId);

  if (session) {
    if (!proxyState.getRigSession(body.rigId)) {
      // Fallback path used — log so admins can detect stratumName mismatches.
      logger.warn(
        { rigId: body.rigId, ownerId: rigRow.ownerId, rentalId },
        "rental: activating on fallback session — possible stratumName mismatch (miner connected under a different rig ID)",
      );
    }
    void session.activateRental(rentalId, body.poolUrl, body.poolWorker, body.poolPassword ?? "x");
  }

  res.status(201).json(newRental);
});

async function loadRentalDetail(id: number) {
  const [row] = await db
    .select({
      id: rentalsTable.id,
      rigId: rentalsTable.rigId,
      rigName: rigsTable.name,
      algorithmName: algorithmsTable.name,
      algorithmUnit: algorithmsTable.unit,
      renterId: rentalsTable.renterId,
      renterDisplayName: usersTable.displayName,
      ownerId: rentalsTable.ownerId,
      hashrate: rentalsTable.hashrate,
      hours: rentalsTable.hours,
      basePricePerUnitPerHour: rentalsTable.basePricePerUnitPerHour,
      renterFeePct: rentalsTable.renterFeePct,
      ownerFeePct: rentalsTable.ownerFeePct,
      renterTotalUsd: rentalsTable.renterTotalUsd,
      ownerEarningsUsd: rentalsTable.ownerEarningsUsd,
      platformFeeUsd: rentalsTable.platformFeeUsd,
      status: rentalsTable.status,
      startedAt: rentalsTable.startedAt,
      endsAt: rentalsTable.endsAt,
      cancelledAt: rentalsTable.cancelledAt,
      settledAt: rentalsTable.settledAt,
      poolUrl: rentalsTable.poolUrl,
      poolWorker: rentalsTable.poolWorker,
      poolPassword: rentalsTable.poolPassword,
      stratumProxyUrl: rentalsTable.stratumProxyUrl,
      proxyWorker: rentalsTable.proxyWorker,
      proxyPassword: rentalsTable.proxyPassword,
      deliveredHashrateAvg: rentalsTable.deliveredHashrateAvg,
      createdAt: rentalsTable.createdAt,
    })
    .from(rentalsTable)
    .innerJoin(rigsTable, eq(rigsTable.id, rentalsTable.rigId))
    .innerJoin(algorithmsTable, eq(algorithmsTable.id, rigsTable.algorithmId))
    .innerJoin(usersTable, eq(usersTable.id, rentalsTable.renterId))
    .where(eq(rentalsTable.id, id));

  if (!row) return null;

  const [ownerRow] = await db
    .select({ displayName: usersTable.displayName })
    .from(usersTable)
    .where(eq(usersTable.id, row.ownerId));

  return GetRentalResponse.parse({
    id: row.id,
    rigId: row.rigId,
    rigName: row.rigName,
    algorithmName: row.algorithmName,
    algorithmUnit: row.algorithmUnit,
    renterId: row.renterId,
    renterDisplayName: row.renterDisplayName,
    ownerId: row.ownerId,
    ownerDisplayName: ownerRow?.displayName ?? "",
    hashrate: toNum(row.hashrate),
    hours: row.hours,
    basePricePerUnitPerHour: toNum(row.basePricePerUnitPerHour),
    renterFeePct: toNum(row.renterFeePct),
    ownerFeePct: toNum(row.ownerFeePct),
    renterTotalUsd: toNum(row.renterTotalUsd),
    ownerEarningsUsd: toNum(row.ownerEarningsUsd),
    platformFeeUsd: toNum(row.platformFeeUsd),
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
    settledAt: row.settledAt ? row.settledAt.toISOString() : null,
    poolUrl: row.poolUrl,
    poolWorker: row.poolWorker,
    poolPassword: row.poolPassword,
    stratumProxyUrl: row.stratumProxyUrl,
    proxyWorker: row.proxyWorker,
    proxyPassword: row.proxyPassword,
    deliveredHashrateAvg:
      row.deliveredHashrateAvg == null ? null : toNum(row.deliveredHashrateAvg),
    createdAt: row.createdAt.toISOString(),
  });
}

router.get("/rentals/:id", async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  await settleExpiredRentals();
  const detail = await loadRentalDetail(id);
  if (!detail) {
    res.status(404).json({ error: "Rental not found" });
    return;
  }
  if (
    detail.renterId !== req.currentUser!.id &&
    detail.ownerId !== req.currentUser!.id &&
    req.currentUser!.role !== "admin"
  ) {
    res.status(403).json({ error: "Not allowed" });
    return;
  }
  // Privacy: never leak the renter's destination pool credentials to anyone
  // who isn't the renter themselves. Owners and admins still see all stats,
  // but the pool URL/worker/password are renter-only secrets.
  if (detail.renterId !== req.currentUser!.id) {
    detail.poolUrl = "";
    detail.poolWorker = "";
    detail.poolPassword = "";
  }
  res.json(detail);
});

router.get("/rentals/:id/stats", async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  await settleExpiredRentals();
  const [rental] = await db
    .select({
      id: rentalsTable.id,
      renterId: rentalsTable.renterId,
      ownerId: rentalsTable.ownerId,
      status: rentalsTable.status,
      hashrate: rentalsTable.hashrate,
      startedAt: rentalsTable.startedAt,
      endsAt: rentalsTable.endsAt,
      deliveredHashrateAvg: rentalsTable.deliveredHashrateAvg,
      sharesAcceptedPersisted: rentalsTable.sharesAccepted,
      sharesRejectedPersisted: rentalsTable.sharesRejected,
      lastShareAtPersisted: rentalsTable.lastShareAt,
      algorithmUnit: algorithmsTable.unit,
    })
    .from(rentalsTable)
    .innerJoin(rigsTable, eq(rigsTable.id, rentalsTable.rigId))
    .innerJoin(algorithmsTable, eq(algorithmsTable.id, rigsTable.algorithmId))
    .where(eq(rentalsTable.id, id));
  if (!rental) {
    res.status(404).json({ error: "Rental not found" });
    return;
  }
  if (
    rental.renterId !== req.currentUser!.id &&
    rental.ownerId !== req.currentUser!.id &&
    req.currentUser!.role !== "admin"
  ) {
    res.status(403).json({ error: "Not allowed" });
    return;
  }
  const now = Date.now();
  const secondsRemaining =
    rental.status === "active"
      ? Math.max(0, Math.floor((rental.endsAt.getTime() - now) / 1000))
      : 0;

  const live = proxyState.getLiveStats(id);
  // advertisedHashrate is in algorithm units (TH, MH, GH, kH); convert to H/s for comparison.
  const algMultiplier = unitMultiplier(rental.algorithmUnit);
  const advertisedH = toNum(rental.hashrate) * algMultiplier;

  // Fetch ALL 60-s samples for the rental so the chart spans the full
  // elapsed/ended duration. Newest-first ordering keeps slice(0, N) as the
  // most-recent N for rolling averages.
  const dbSamples = await db
    .select({
      sampledAt: rentalHashSamplesTable.sampledAt,
      effectiveHashrateH: rentalHashSamplesTable.effectiveHashrateH,
    })
    .from(rentalHashSamplesTable)
    .where(eq(rentalHashSamplesTable.rentalId, id))
    .orderBy(desc(rentalHashSamplesTable.sampledAt));

  // Average over a slice (newest-first), returns H/s
  const avgH = (slice: typeof dbSamples) =>
    slice.length > 0
      ? slice.reduce((s, x) => s + toNum(x.effectiveHashrateH ?? "0"), 0) /
        slice.length
      : 0;

  const hashrate10mH = avgH(dbSamples.slice(0, 10)); // last 10 min
  const hashrate1hH = avgH(dbSamples.slice(0, 60)); // last 60 min

  // Delivery is the CUMULATIVE average since rental start so the percentage
  // reflects "how much hashrate did the renter actually receive over the
  // elapsed period vs. what the rig owner advertised". `deliveredHashrateAvg`
  // is maintained in algorithm units (TH/MH/...) — multiply back to H/s.
  const avgDeliveredH =
    rental.deliveredHashrateAvg != null
      ? toNum(rental.deliveredHashrateAvg) * algMultiplier
      : 0;

  const hashrate10m = hashrate10mH / algMultiplier;
  const hashrate1h = hashrate1hH / algMultiplier;

  const deliveryRatio =
    advertisedH > 0 && avgDeliveredH > 0
      ? Math.min(1.05, avgDeliveredH / advertisedH)
      : 0;

  // Chart: chronological order (oldest → newest) in algorithm units. Cap
  // at MAX_CHART_POINTS by bucket-averaging so very long rentals don't
  // ship megabytes of JSON to the renter's browser. The chart compresses
  // along the X-axis but every point still represents real measured data.
  const MAX_CHART_POINTS = 720;
  const chronological = dbSamples.slice().reverse();
  let samples: { timestamp: string; hashrate: number }[];
  if (chronological.length <= MAX_CHART_POINTS) {
    samples = chronological.map((s) => ({
      timestamp: s.sampledAt.toISOString(),
      hashrate: toNum(s.effectiveHashrateH ?? "0") / algMultiplier,
    }));
  } else {
    const bucketSize = Math.ceil(chronological.length / MAX_CHART_POINTS);
    samples = [];
    for (let i = 0; i < chronological.length; i += bucketSize) {
      const bucket = chronological.slice(i, i + bucketSize);
      const sum = bucket.reduce(
        (s, x) => s + toNum(x.effectiveHashrateH ?? "0"),
        0,
      );
      samples.push({
        timestamp: bucket[Math.floor(bucket.length / 2)]!.sampledAt.toISOString(),
        hashrate: sum / bucket.length / algMultiplier,
      });
    }
  }

  // Combine DB-persisted cumulative shares with in-memory shares since the
  // last flush. The DB row keeps totals across server restarts; the in-memory
  // delta covers shares received in the current flush window. Together they
  // give a complete count that survives deploys without double-counting.
  const unflushed = proxyState.peekUnflushedShareDelta(id);
  const totalSharesAccepted = rental.sharesAcceptedPersisted + unflushed.deltaAccepted;
  const totalSharesRejected = rental.sharesRejectedPersisted + unflushed.deltaRejected;

  // Display-stability: smooth over normal ASIC reconnect cycles so the UI
  // doesn't flap to OFFLINE / 0 H/s every minute. See top-of-file comment.
  // Use the most-recent share timestamp from either source so the grace
  // window survives restarts (DB row carries the persisted lastShareAt).
  const effectiveLastShareAt =
    live.lastShareAt ?? rental.lastShareAtPersisted ?? null;
  const inGrace = withinGrace(effectiveLastShareAt);
  const minerConnectedDisplay = live.minerConnected || inGrace;
  const upstreamConnectedDisplay = live.upstreamConnected || inGrace;
  // Display-hashrate fallback chain (resolves the "stats freeze at 0" bug):
  //   1. Live rolling buffer (2-min lookback) — present when rig is mining now.
  //   2. Most-recent non-zero DB sample (30-min lookback) — covers reconnect
  //      gaps and the seconds immediately after a miner restart.
  //   3. Cumulative deliveredHashrateAvg since rental start — guarantees a
  //      meaningful number for any rental that has ever produced shares.
  let displayHashrateH = live.effectiveHashrateH;
  if (displayHashrateH === 0) {
    displayHashrateH = await getMostRecentNonZeroHashrateH(id);
  }
  if (displayHashrateH === 0 && avgDeliveredH > 0) {
    displayHashrateH = avgDeliveredH;
  }

  let message: string | null = null;
  if (rental.status === "active" && !minerConnectedDisplay) {
    message = "Awaiting miner connection — point your rig at the proxy URL.";
  } else if (rental.status === "active" && minerConnectedDisplay && live.poolAuthFailed) {
    message = "Pool rejected worker credentials — check your pool worker name and password.";
  } else if (rental.status === "active" && minerConnectedDisplay && !upstreamConnectedDisplay) {
    message = "Miner connected — establishing upstream pool connection.";
  } else if (rental.status !== "active" && samples.length === 0) {
    message = "No hashrate data recorded for this rental.";
  }

  const data = GetRentalStatsResponse.parse({
    rentalId: rental.id,
    currentHashrate: displayHashrateH / algMultiplier,
    averageHashrate: avgDeliveredH / algMultiplier,
    hashrate10m,
    hashrate1h,
    deliveryRatio,
    sharesAccepted: totalSharesAccepted,
    sharesRejected: totalSharesRejected,
    secondsRemaining,
    status: rental.status,
    samples,
    message,
    minerConnected: minerConnectedDisplay,
    upstreamConnected: upstreamConnectedDisplay,
    poolAuthFailed: live.poolAuthFailed,
  });
  res.json(data);
});

router.get("/rentals/:id/live", async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [rental] = await db
    .select({
      id: rentalsTable.id,
      renterId: rentalsTable.renterId,
      ownerId: rentalsTable.ownerId,
      status: rentalsTable.status,
      hashrate: rentalsTable.hashrate,
      endsAt: rentalsTable.endsAt,
      deliveredHashrateAvg: rentalsTable.deliveredHashrateAvg,
      sharesAcceptedPersisted: rentalsTable.sharesAccepted,
      sharesRejectedPersisted: rentalsTable.sharesRejected,
      lastShareAtPersisted: rentalsTable.lastShareAt,
      algorithmUnit: algorithmsTable.unit,
    })
    .from(rentalsTable)
    .innerJoin(rigsTable, eq(rigsTable.id, rentalsTable.rigId))
    .innerJoin(algorithmsTable, eq(algorithmsTable.id, rigsTable.algorithmId))
    .where(eq(rentalsTable.id, id));
  if (!rental) {
    res.status(404).json({ error: "Rental not found" });
    return;
  }
  if (
    rental.renterId !== req.currentUser!.id &&
    rental.ownerId !== req.currentUser!.id &&
    req.currentUser!.role !== "admin"
  ) {
    res.status(403).json({ error: "Not allowed" });
    return;
  }

  const live = proxyState.getLiveStats(id);
  const algMultiplier = unitMultiplier(rental.algorithmUnit);
  const advertisedH = toNum(rental.hashrate) * algMultiplier;

  // Combine DB-persisted cumulative shares with in-memory shares since the
  // last flush — see /stats endpoint for rationale.
  const unflushed = proxyState.peekUnflushedShareDelta(id);
  const totalSharesAccepted = rental.sharesAcceptedPersisted + unflushed.deltaAccepted;
  const totalSharesRejected = rental.sharesRejectedPersisted + unflushed.deltaRejected;
  const effectiveLastShareAt =
    live.lastShareAt ?? rental.lastShareAtPersisted ?? null;

  // Display-stability: smooth over normal ASIC reconnect cycles. See top-of-file comment.
  const inGrace = withinGrace(effectiveLastShareAt);
  const minerConnectedDisplay = live.minerConnected || inGrace;
  const upstreamConnectedDisplay = live.upstreamConnected || inGrace;

  // Same fallback chain as /stats: live → most-recent non-zero sample →
  // cumulative deliveredHashrateAvg. Without the cumulative tail the rental
  // detail UI flaps to 0 H/s every time the rig drops momentarily.
  const cumulativeAvgH =
    rental.deliveredHashrateAvg != null
      ? toNum(rental.deliveredHashrateAvg) * algMultiplier
      : 0;
  let displayHashrateH = live.effectiveHashrateH;
  if (displayHashrateH === 0) {
    displayHashrateH = await getMostRecentNonZeroHashrateH(id);
  }
  if (displayHashrateH === 0 && cumulativeAvgH > 0) {
    displayHashrateH = cumulativeAvgH;
  }
  // Delivery ratio = average delivered hashrate over the elapsed rental
  // period ÷ advertised hashrate. The cumulative average includes
  // zero-share windows for periods when the rig was disconnected, so a rig
  // that delivered full hashrate for half the rental and was offline for
  // the other half scores ~0.5. This is the right number for a renter
  // deciding whether to keep the rental running or cancel it — it reflects
  // ACTUAL delivery so far, not the instantaneous reading.
  const deliveryRatio =
    advertisedH > 0 && cumulativeAvgH > 0
      ? Math.min(1.05, cumulativeAvgH / advertisedH)
      : 0;

  res.json({
    rentalId: id,
    status: rental.status,
    minerConnected: minerConnectedDisplay,
    upstreamConnected: upstreamConnectedDisplay,
    poolAuthFailed: live.poolAuthFailed,
    currentHashrateH: displayHashrateH,
    currentHashrate: displayHashrateH / algMultiplier,
    sharesAccepted: totalSharesAccepted,
    sharesRejected: totalSharesRejected,
    currentDifficulty: live.currentDifficulty,
    lastShareAt: effectiveLastShareAt?.toISOString() ?? null,
    deliveryRatio,
    secondsRemaining:
      rental.status === "active"
        ? Math.max(0, Math.floor((rental.endsAt.getTime() - Date.now()) / 1000))
        : 0,
  });
});

/**
 * Live-switch the destination pool for an active rental. Updates the rental
 * row in place and triggers a clean miner reconnect so the new pool gets a
 * fresh subscription with the correct extranonce.
 */
router.post("/rentals/:id/switch-pool", async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const body = SwitchRentalPoolBody.parse(req.body);

  const ssrfError = await validatePoolUrl(body.poolUrl);
  if (ssrfError) {
    res.status(400).json({ error: ssrfError });
    return;
  }

  const [rental] = await db
    .select()
    .from(rentalsTable)
    .where(eq(rentalsTable.id, id));
  if (!rental) {
    res.status(404).json({ error: "Rental not found" });
    return;
  }
  if (rental.renterId !== req.currentUser!.id) {
    res.status(403).json({ error: "Only the renter can switch pools" });
    return;
  }
  if (rental.status !== "active") {
    res
      .status(400)
      .json({ error: "Pool can only be switched while the rental is active" });
    return;
  }

  await db
    .update(rentalsTable)
    .set({
      poolUrl: body.poolUrl,
      poolWorker: body.poolWorker,
      poolPassword: body.poolPassword ?? "x",
    })
    .where(eq(rentalsTable.id, id));

  // ALWAYS evict any parked upstream first — even if no live session is
  // found right now (rig briefly disconnected). Otherwise the miner could
  // reconnect and claim a parked OLD-pool upstream, silently mining to the
  // previous pool. Safe to call when nothing is parked.
  proxyState.removeParkedUpstream(rental.id);

  // Find the live session — prefer rentalId lookup so shadow rigs work too.
  const session =
    proxyState.getSessionByRentalId(rental.id) ??
    proxyState.getRigSession(rental.rigId);
  if (session) {
    void session.switchRentalPool(rental.id);
  }

  const detail = await loadRentalDetail(rental.id);
  res.json(SwitchRentalPoolResponse.parse(detail));
});

router.post("/rentals/:id/cancel", async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [rental] = await db
    .select()
    .from(rentalsTable)
    .where(eq(rentalsTable.id, id));
  if (!rental) {
    res.status(404).json({ error: "Rental not found" });
    return;
  }
  if (rental.renterId !== req.currentUser!.id) {
    res.status(403).json({ error: "Only the renter can cancel" });
    return;
  }
  if (rental.status !== "active") {
    res.status(400).json({ error: "Rental is not active" });
    return;
  }

  await db.transaction(async (tx) => {
    const now = new Date();

    // Atomic claim — only the first concurrent caller wins.
    const [claimed] = await tx
      .update(rentalsTable)
      .set({
        status: "cancelled",
        cancelledAt: now,
        settledAt: now,
      })
      .where(
        sql`${rentalsTable.id} = ${rental.id} AND ${rentalsTable.status} = 'active'`,
      )
      .returning();
    if (!claimed) return;

    // Delivery-based cancellation settlement (same model as expiry settlement).
    // deliveryRatio: what fraction of advertised hashrate was actually delivered.
    // usedRatio: what fraction of the booked time elapsed before cancellation.
    // effectiveRatio = deliveryRatio × usedRatio → owner earned this fraction of fees.
    const totalSeconds =
      (rental.endsAt.getTime() - rental.startedAt.getTime()) / 1000;
    const usedSeconds = Math.max(
      0,
      Math.min(totalSeconds, (now.getTime() - rental.startedAt.getTime()) / 1000),
    );
    const usedRatio = totalSeconds > 0 ? usedSeconds / totalSeconds : 1;

    const deliveryRatio = computeDeliveryRatio(
      rental.deliveredHashrateAvg,
      rental.hashrate,
    );

    const effectiveRatio = deliveryRatio * usedRatio;
    const ownerPayout = round6(toNum(rental.ownerEarningsUsd) * effectiveRatio);
    const renterRefund = round6(toNum(rental.renterTotalUsd) * (1 - effectiveRatio));

    await tx
      .update(rigsTable)
      .set({ status: "available" })
      .where(eq(rigsTable.id, rental.rigId));

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
          memo: `Delivery-based refund for cancelled rental #${rental.id} (${Math.round(effectiveRatio * 100)}% of value delivered)`,
          relatedRentalId: rental.id,
        });
      }
    }

    if (ownerPayout > 0) {
      const payoutStr = toUsdString(ownerPayout);
      const [credited] = await tx
        .update(usersTable)
        .set({
          balanceUsd: sql`${usersTable.balanceUsd} + ${payoutStr}`,
          totalEarnedUsd: sql`${usersTable.totalEarnedUsd} + ${payoutStr}`,
        })
        .where(eq(usersTable.id, rental.ownerId))
        .returning({ balanceUsd: usersTable.balanceUsd });
      if (credited) {
        await tx.insert(walletTransactionsTable).values({
          userId: rental.ownerId,
          type: "rental_payout",
          amountUsd: payoutStr,
          balanceAfterUsd: toUsdString(round6(toNum(credited.balanceUsd))),
          memo: `Delivery-based payout for cancelled rental #${rental.id} (${Math.round(deliveryRatio * 100)}% delivery × ${Math.round(usedRatio * 100)}% time used)`,
          relatedRentalId: rental.id,
        });
      }
    }
  });

  // Tear down any live proxy routing for this rental.
  // Look up by rentalId first — works for both normal rigs AND shadow rigs
  // (auto-created when miner connects with a stratumName that doesn't match
  // the listed rig). Falling back to rental.rigId would silently miss shadow
  // rigs, leaving the renter's pool connection alive — the rig would keep
  // mining for the renter after termination instead of returning to the owner.
  const session =
    proxyState.getSessionByRentalId(rental.id) ??
    proxyState.getRigSession(rental.rigId);
  if (session) {
    session.deactivateRental();
  } else {
    // No live session — flush any unflushed share counters into the rentals
    // row, then clean up the share window so the flush loop stops inserting
    // samples for this finished rental.
    await flushAndRemoveRentalWindow(rental.id);
  }

  const detail = await loadRentalDetail(rental.id);
  res.json(CancelRentalResponse.parse(detail));
});

router.post("/rentals/:id/review", async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const body = CreateRentalReviewBody.parse(req.body);
  const [rental] = await db
    .select()
    .from(rentalsTable)
    .where(eq(rentalsTable.id, id));
  if (!rental) {
    res.status(404).json({ error: "Rental not found" });
    return;
  }
  if (rental.renterId !== req.currentUser!.id) {
    res.status(403).json({ error: "Only the renter can review" });
    return;
  }
  if (rental.status !== "completed" && rental.status !== "cancelled") {
    res
      .status(400)
      .json({ error: "Rental must be completed or cancelled to review" });
    return;
  }
  const [existing] = await db
    .select({ id: reviewsTable.id })
    .from(reviewsTable)
    .where(eq(reviewsTable.rentalId, rental.id));
  if (existing) {
    res.status(400).json({ error: "Review already submitted for this rental" });
    return;
  }

  const [created] = await db
    .insert(reviewsTable)
    .values({
      rentalId: rental.id,
      rigId: rental.rigId,
      renterId: req.currentUser!.id,
      rating: body.rating,
      body: body.body,
    })
    .returning();

  if (!created) {
    res.status(500).json({ error: "Failed to create review" });
    return;
  }

  const data = ListRigReviewsResponseItem.parse({
    id: created.id,
    rigId: created.rigId,
    rentalId: created.rentalId,
    renterDisplayName: req.currentUser!.displayName,
    rating: created.rating,
    body: created.body,
    createdAt: created.createdAt.toISOString(),
  });
  res.status(201).json(data);
});

router.get("/me/rentals", async (req, res) => {
  await settleExpiredRentals();
  const rows = await db
    .select({
      id: rentalsTable.id,
      rigId: rentalsTable.rigId,
      rigName: rigsTable.name,
      algorithmName: algorithmsTable.name,
      algorithmUnit: algorithmsTable.unit,
      renterId: rentalsTable.renterId,
      renterDisplayName: usersTable.displayName,
      ownerId: rentalsTable.ownerId,
      hashrate: rentalsTable.hashrate,
      hours: rentalsTable.hours,
      renterTotalUsd: rentalsTable.renterTotalUsd,
      ownerEarningsUsd: rentalsTable.ownerEarningsUsd,
      status: rentalsTable.status,
      startedAt: rentalsTable.startedAt,
      endsAt: rentalsTable.endsAt,
      deliveredHashrateAvg: rentalsTable.deliveredHashrateAvg,
    })
    .from(rentalsTable)
    .innerJoin(rigsTable, eq(rigsTable.id, rentalsTable.rigId))
    .innerJoin(algorithmsTable, eq(algorithmsTable.id, rigsTable.algorithmId))
    .innerJoin(usersTable, eq(usersTable.id, rentalsTable.renterId))
    .where(eq(rentalsTable.renterId, req.currentUser!.id))
    .orderBy(desc(rentalsTable.createdAt));

  const ownerIds = Array.from(new Set(rows.map((r) => r.ownerId)));
  const owners = ownerIds.length
    ? await db
        .select({ id: usersTable.id, displayName: usersTable.displayName })
        .from(usersTable)
        .where(inArray(usersTable.id, ownerIds))
    : [];
  const ownerMap = new Map(owners.map((o) => [o.id, o.displayName]));

  const data = ListMyRentalsResponse.parse(
    rows.map((r) => ({
      id: r.id,
      rigId: r.rigId,
      rigName: r.rigName,
      algorithmName: r.algorithmName,
      algorithmUnit: r.algorithmUnit,
      renterId: r.renterId,
      renterDisplayName: r.renterDisplayName,
      ownerId: r.ownerId,
      ownerDisplayName: ownerMap.get(r.ownerId) ?? "",
      hashrate: toNum(r.hashrate),
      hours: r.hours,
      renterTotalUsd: toNum(r.renterTotalUsd),
      ownerEarningsUsd: toNum(r.ownerEarningsUsd),
      status: r.status,
      startedAt: r.startedAt.toISOString(),
      endsAt: r.endsAt.toISOString(),
      deliveredHashrateAvg:
        r.deliveredHashrateAvg == null ? null : toNum(r.deliveredHashrateAvg),
    })),
  );
  res.json(data);
});

router.get("/me/rentals/lessor", async (req, res) => {
  await settleExpiredRentals();
  const rows = await db
    .select({
      id: rentalsTable.id,
      rigId: rentalsTable.rigId,
      rigName: rigsTable.name,
      algorithmName: algorithmsTable.name,
      algorithmUnit: algorithmsTable.unit,
      renterId: rentalsTable.renterId,
      renterDisplayName: usersTable.displayName,
      ownerId: rentalsTable.ownerId,
      hashrate: rentalsTable.hashrate,
      hours: rentalsTable.hours,
      renterTotalUsd: rentalsTable.renterTotalUsd,
      ownerEarningsUsd: rentalsTable.ownerEarningsUsd,
      status: rentalsTable.status,
      startedAt: rentalsTable.startedAt,
      endsAt: rentalsTable.endsAt,
      deliveredHashrateAvg: rentalsTable.deliveredHashrateAvg,
    })
    .from(rentalsTable)
    .innerJoin(rigsTable, eq(rigsTable.id, rentalsTable.rigId))
    .innerJoin(algorithmsTable, eq(algorithmsTable.id, rigsTable.algorithmId))
    .innerJoin(usersTable, eq(usersTable.id, rentalsTable.renterId))
    .where(eq(rentalsTable.ownerId, req.currentUser!.id))
    .orderBy(desc(rentalsTable.createdAt));

  const data = ListLessorRentalsResponse.parse(
    rows.map((r) => ({
      id: r.id,
      rigId: r.rigId,
      rigName: r.rigName,
      algorithmName: r.algorithmName,
      algorithmUnit: r.algorithmUnit,
      renterId: r.renterId,
      renterDisplayName: r.renterDisplayName,
      ownerId: r.ownerId,
      ownerDisplayName: req.currentUser!.displayName,
      hashrate: toNum(r.hashrate),
      hours: r.hours,
      renterTotalUsd: toNum(r.renterTotalUsd),
      ownerEarningsUsd: toNum(r.ownerEarningsUsd),
      status: r.status,
      startedAt: r.startedAt.toISOString(),
      endsAt: r.endsAt.toISOString(),
      deliveredHashrateAvg:
        r.deliveredHashrateAvg == null ? null : toNum(r.deliveredHashrateAvg),
    })),
  );
  res.json(data);
});

export default router;
