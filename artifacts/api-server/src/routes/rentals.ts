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
  ExtendRentalBody,
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

function buildProxyCreds(algorithmSlug?: string | null) {
  // STRATUM_HOST should be set on the VPS (e.g. livehashrate.com).
  // Falls back to REPLIT_DEV_DOMAIN for local dev, then a safe placeholder.
  const host =
    process.env["STRATUM_HOST"] ??
    process.env["REPLIT_DEV_DOMAIN"] ??
    "livehashrate.com";
  // Legacy `sha256` rigs (no ASICBoost) are served on a separate listener
  // that refuses version-rolling — use that port so renters wire their
  // mining client to the correct endpoint for the rig they're booking.
  const isLegacy = algorithmSlug === "sha256";
  const port = isLegacy
    ? process.env["STRATUM_LEGACY_PORT"] ?? "3334"
    : process.env["STRATUM_PORT"] ?? "3333";
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
      ownerPricePerDay: rigsTable.pricePerUnitPerDay,
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
  // Owner override: pricePerUnitPerDay/24 takes precedence over algorithm default.
  const basePrice =
    rigRow.ownerPricePerDay != null
      ? toNum(rigRow.ownerPricePerDay) / 24
      : toNum(rigRow.basePrice);
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
      ownerPricePerDay: rigsTable.pricePerUnitPerDay,
      algorithmSlug: algorithmsTable.slug,
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
  // Owner override: pricePerUnitPerDay/24 takes precedence over algorithm default.
  const basePrice =
    rigRow.ownerPricePerDay != null
      ? toNum(rigRow.ownerPricePerDay) / 24
      : toNum(rigRow.basePrice);
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

      const proxy = buildProxyCreds(rigRow.algorithmSlug);
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

  // If the rig owner's miners are already connected to the proxy, start routing immediately.
  // Activate ALL sessions for this rigId so every connected device switches to the
  // renter's pool — not just the first one.
  const sessions = proxyState.getRigSessions(body.rigId);

  if (sessions.length > 0) {
    for (const s of sessions) {
      void s.activateRental(rentalId, body.poolUrl, body.poolWorker, body.poolPassword ?? "x");
    }
  } else {
    // Fallback: miner connected under a different stratumName (shadow rig).
    // Only safe when exactly one owner session exists (ambiguous otherwise).
    const fallbackSession = proxyState.getAnySessionForOwner(rigRow.ownerId);
    if (fallbackSession) {
      logger.warn(
        { rigId: body.rigId, ownerId: rigRow.ownerId, rentalId },
        "rental: activating on fallback session — possible stratumName mismatch (miner connected under a different rig ID)",
      );
      void fallbackSession.activateRental(rentalId, body.poolUrl, body.poolWorker, body.poolPassword ?? "x");
    }
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
      maxRentalHours: rigsTable.maxRentalHours,
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

  // Sum any refunds (renter side) and any payouts (owner side) recorded in
  // the wallet ledger for this rental. Used so the UI can show what was
  // actually paid / earned, not the contract amounts.
  const [refundAgg] = await db
    .select({
      total: sql<string>`COALESCE(SUM(${walletTransactionsTable.amountUsd}), 0)`,
    })
    .from(walletTransactionsTable)
    .where(
      and(
        eq(walletTransactionsTable.userId, row.renterId),
        eq(walletTransactionsTable.type, "rental_refund"),
        eq(walletTransactionsTable.relatedRentalId, row.id),
      ),
    );
  const [payoutAgg] = await db
    .select({
      total: sql<string>`COALESCE(SUM(${walletTransactionsTable.amountUsd}), 0)`,
    })
    .from(walletTransactionsTable)
    .where(
      and(
        eq(walletTransactionsTable.userId, row.ownerId),
        eq(walletTransactionsTable.type, "rental_payout"),
        eq(walletTransactionsTable.relatedRentalId, row.id),
      ),
    );
  const refundTotal = toNum(refundAgg?.total ?? "0");
  const payoutTotal = toNum(payoutAgg?.total ?? "0");

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
    netPaidUsd: round6(Math.max(0, toNum(row.renterTotalUsd) - refundTotal)),
    ownerEarningsUsd: toNum(row.ownerEarningsUsd),
    netOwnerEarnedUsd: round6(Math.max(0, payoutTotal)),
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
    maxRentalHours: row.maxRentalHours,
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
      const hasOffline = bucket.some((x) => toNum(x.effectiveHashrateH ?? "0") === 0);
      const sum = bucket.reduce(
        (s, x) => s + toNum(x.effectiveHashrateH ?? "0"),
        0,
      );
      samples.push({
        timestamp: bucket[Math.floor(bucket.length / 2)]!.sampledAt.toISOString(),
        hashrate: hasOffline ? 0 : sum / bucket.length / algMultiplier,
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
  // Display-hashrate fallback chain:
  // CURRENT HASHRATE = live rolling buffer only (2-min lookback).
  // Shows 0 immediately when the rig stops sending shares — no stale fallback.
  const displayHashrateH = live.effectiveHashrateH;

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
  res.setHeader("Cache-Control", "no-store");
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

  // Display-hashrate fallback chain (same as /stats):
  //   1. Live rolling buffer — present when rig is mining.
  // CURRENT HASHRATE = live rolling buffer only. Shows 0 when rig is offline.
  const displayHashrateH = live.effectiveHashrateH;
  const cumulativeAvgH =
    rental.deliveredHashrateAvg != null
      ? toNum(rental.deliveredHashrateAvg) * algMultiplier
      : 0;
  // Delivery ratio uses the time-weighted cumulative average, which accounts
  // for all offline time since rental start (server updates this every 60 s).
  const deliveryRatio =
    advertisedH > 0 && cumulativeAvgH > 0
      ? Math.min(1.05, cumulativeAvgH / advertisedH)
      : 0;

  // Only show per-worker stats when the rig is actively mining. If hashrate
  // is zero the session may still hold a TCP connection but no shares are
  // flowing — returning stale difficulty / share counts from that frozen
  // session is misleading, so we clear the list.
  const workers = displayHashrateH > 0 ? proxyState.getRentalWorkerStats(id) : [];

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
    currentDifficulty: displayHashrateH > 0 ? live.currentDifficulty : 0,
    lastShareAt: effectiveLastShareAt?.toISOString() ?? null,
    deliveryRatio,
    secondsRemaining:
      rental.status === "active"
        ? Math.max(0, Math.floor((rental.endsAt.getTime() - Date.now()) / 1000))
        : 0,
    workers,
  });
});

/**
 * Live-switch the destination pool for an active rental. Updates the rental
 * row in place and triggers a clean miner reconnect so the new pool gets a
 * fresh subscription with the correct extranonce.
 */
/**
 * Extend an active rental by additional hours. Charges the renter at the
 * rental's locked-in price (basePricePerUnitPerHour × hashrate × extraHours
 * + renterFeePct), credits the owner's allocated earnings, and pushes
 * `endsAt` forward. Total `hours` must remain within the rig owner's
 * `maxRentalHours` cap. Settlement, /live secondsRemaining, and the
 * stratum proxy all read `endsAt` from the DB, so no in-memory state
 * needs to be touched.
 */
router.post("/rentals/:id/extend", async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const body = ExtendRentalBody.parse(req.body);

  const [row] = await db
    .select({
      rental: rentalsTable,
      maxRentalHours: rigsTable.maxRentalHours,
    })
    .from(rentalsTable)
    .innerJoin(rigsTable, eq(rigsTable.id, rentalsTable.rigId))
    .where(eq(rentalsTable.id, id));
  if (!row) {
    res.status(404).json({ error: "Rental not found" });
    return;
  }
  const { rental, maxRentalHours } = row;
  if (rental.renterId !== req.currentUser!.id) {
    res.status(403).json({ error: "Only the renter can extend this rental" });
    return;
  }
  if (rental.status !== "active") {
    res
      .status(400)
      .json({ error: "Only active rentals can be extended" });
    return;
  }

  const newTotalHours = rental.hours + body.extraHours;
  if (newTotalHours > maxRentalHours) {
    res.status(400).json({
      error: `Total rental cannot exceed ${maxRentalHours} hours (rig owner's cap). You can add at most ${Math.max(0, maxRentalHours - rental.hours)} more hour(s).`,
    });
    return;
  }

  const hashrate = toNum(rental.hashrate);
  const basePrice = toNum(rental.basePricePerUnitPerHour);
  const renterFeePct = toNum(rental.renterFeePct);
  const ownerFeePct = toNum(rental.ownerFeePct);
  const extra = priceForRental({
    hashrate,
    hours: body.extraHours,
    basePrice,
    renterFeePct,
    ownerFeePct,
  });

  const extraRenterStr = toUsdString(extra.renterTotalUsd);
  const newRenterTotalStr = toUsdString(
    round6(toNum(rental.renterTotalUsd) + extra.renterTotalUsd),
  );
  const newOwnerEarningsStr = toUsdString(
    round6(toNum(rental.ownerEarningsUsd) + extra.ownerEarningsUsd),
  );
  const newPlatformFeeStr = toUsdString(
    round6(toNum(rental.platformFeeUsd) + extra.platformFeeUsd),
  );
  const newEndsAt = new Date(
    rental.endsAt.getTime() + body.extraHours * 3600 * 1000,
  );

  class TxError extends Error {
    constructor(public readonly code: "insufficient" | "race") {
      super(code);
      this.name = "TxError";
    }
  }

  try {
    await db.transaction(async (tx) => {
      const [debited] = await tx
        .update(usersTable)
        .set({
          balanceUsd: sql`${usersTable.balanceUsd} - ${extraRenterStr}`,
          totalSpentUsd: sql`${usersTable.totalSpentUsd} + ${extraRenterStr}`,
        })
        .where(
          sql`${usersTable.id} = ${req.currentUser!.id} AND ${usersTable.balanceUsd} >= ${extraRenterStr}`,
        )
        .returning({ balanceUsd: usersTable.balanceUsd });
      if (!debited) throw new TxError("insufficient");

      // Re-check status under the row lock so we don't extend a rental that
      // just transitioned to cancelled/completed/disputed in another request.
      const [updated] = await tx
        .update(rentalsTable)
        .set({
          hours: newTotalHours,
          endsAt: newEndsAt,
          renterTotalUsd: newRenterTotalStr,
          ownerEarningsUsd: newOwnerEarningsStr,
          platformFeeUsd: newPlatformFeeStr,
        })
        .where(
          and(
            eq(rentalsTable.id, id),
            eq(rentalsTable.status, "active"),
          ),
        )
        .returning({ id: rentalsTable.id });
      if (!updated) throw new TxError("race");

      await tx.insert(walletTransactionsTable).values({
        userId: req.currentUser!.id,
        type: "rental_charge",
        amountUsd: toUsdString(-extra.renterTotalUsd),
        balanceAfterUsd: toUsdString(round6(toNum(debited.balanceUsd))),
        memo: `Rental #${id} extended by ${body.extraHours}h`,
        relatedRentalId: id,
      });
    });
  } catch (err) {
    if (err instanceof TxError) {
      if (err.code === "insufficient") {
        res.status(402).json({
          error: `Insufficient balance. Need $${extra.renterTotalUsd.toFixed(2)}.`,
        });
      } else {
        res.status(400).json({
          error: "Rental status changed — refresh and try again",
        });
      }
      return;
    }
    throw err;
  }

  const detail = await loadRentalDetail(id);
  res.json(detail);
});

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

  // Switch ALL live sessions for this rental (multiple devices on same rigId).
  const switchSessions = proxyState.getSessionsByRentalId(rental.id);
  if (switchSessions.length > 0) {
    for (const s of switchSessions) void s.switchRentalPool(rental.id);
  } else {
    const fallback = proxyState.getRigSession(rental.rigId);
    if (fallback) void fallback.switchRentalPool(rental.id);
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

  // Threshold: at-or-above this delivery ratio we treat the rig as fully
  // performant and settle on time-used alone (renter pays only for elapsed
  // hours, owner is credited for elapsed hours). Below it we FREEZE funds
  // and route the dispute to an admin — the user is not auto-refunded and
  // the owner is not auto-paid, because either party may legitimately be
  // owed more or less than a naive proportional split.
  const FULL_DELIVERY_THRESHOLD = 0.95;

  await db.transaction(async (tx) => {
    const now = new Date();
    const deliveryRatio = computeDeliveryRatio(
      rental.deliveredHashrateAvg,
      rental.hashrate,
    );
    const isDisputed = deliveryRatio < FULL_DELIVERY_THRESHOLD;

    // Atomic claim — only the first concurrent caller wins.
    const [claimed] = await tx
      .update(rentalsTable)
      .set({
        status: isDisputed ? "disputed" : "cancelled",
        cancelledAt: now,
        // Disputed rentals stay unsettled until admin resolution — only set
        // settledAt for clean cancellations.
        settledAt: isDisputed ? null : now,
      })
      .where(
        sql`${rentalsTable.id} = ${rental.id} AND ${rentalsTable.status} = 'active'`,
      )
      .returning();
    if (!claimed) return;

    await tx
      .update(rigsTable)
      .set({ status: "available" })
      .where(eq(rigsTable.id, rental.rigId));

    if (isDisputed) {
      // Three-bucket dispute model:
      //   1. Unused-time portion → refund to renter immediately (undisputed).
      //   2. Delivered portion of elapsed time → pay owner immediately.
      //      The owner did provide this service; it is not in dispute.
      //   3. Undelivered portion of elapsed time → FROZEN. Admin has 24h to
      //      award it to either party. Auto-resolves in renter's favour if
      //      no admin action by then.
      //
      // Cancellation penalty (cancelFee): applies only when deliveryRatio > 0
      // (i.e. the rig was partially delivering — renter cancelled voluntarily).
      // When deliveryRatio = 0 (rig completely offline / disconnected), NO
      // penalty — it is entirely the rig's fault. The cancel fee is deducted
      // from the frozen amount before it is put in dispute.
      const totalSecondsD =
        (rental.endsAt.getTime() - rental.startedAt.getTime()) / 1000;
      const usedSecondsD = Math.max(
        0,
        Math.min(totalSecondsD, (now.getTime() - rental.startedAt.getTime()) / 1000),
      );
      const usedRatioD = totalSecondsD > 0 ? usedSecondsD / totalSecondsD : 1;
      const unusedRefund = round6(toNum(rental.renterTotalUsd) * (1 - usedRatioD));
      // Owner earned deliveryRatio of the elapsed portion — pay immediately.
      const ownerDeliveredPayout = round6(toNum(rental.ownerEarningsUsd) * usedRatioD * deliveryRatio);
      // Cancel fee on elapsed cost (only when rig was partially delivering).
      const elapsedCostD = round6(toNum(rental.renterTotalUsd) * usedRatioD);
      const cD = deliveryRatio > 0 ? await getCommission() : null;
      const cancelFeePctD = cD ? Math.max(0, Math.min(100, cD.cancellationFeePct)) : 0;
      const cancelFeeD = round6(elapsedCostD * (cancelFeePctD / 100));
      // Frozen = undelivered share of elapsed cost, minus cancel fee (which
      // goes to platform immediately). Floored at 0 to prevent negatives.
      const frozenBeforeD = round6(toNum(rental.renterTotalUsd) * usedRatioD * (1 - deliveryRatio));
      const frozenAmount = round6(Math.max(0, frozenBeforeD - cancelFeeD));

      if (unusedRefund > 0) {
        const refundStr = toUsdString(unusedRefund);
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
            memo: `Unused-time refund for disputed rental #${rental.id} (${Math.round((1 - usedRatioD) * 100)}% of booked time was unused)`,
            relatedRentalId: rental.id,
          });
        }
      }

      // Pay owner the portion they genuinely delivered (undisputed).
      if (ownerDeliveredPayout > 0) {
        const payoutStr = toUsdString(ownerDeliveredPayout);
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
            memo: `Delivered-portion payout for disputed rental #${rental.id} (${Math.round(deliveryRatio * 100)}% delivered × ${Math.round(usedRatioD * 100)}% elapsed)`,
            relatedRentalId: rental.id,
          });
        }
      }

      // Persist frozen amount and actual platform fee into the rental row.
      // platformFeeUsd = delivered share of contracted fee + cancel fee (if any).
      const platformFeeEarnedD = round6(toNum(rental.platformFeeUsd) * usedRatioD * deliveryRatio + cancelFeeD);
      await tx
        .update(rentalsTable)
        .set({
          frozenUsd: toUsdString(frozenAmount),
          platformFeeUsd: toUsdString(platformFeeEarnedD),
        })
        .where(eq(rentalsTable.id, rental.id));

      // Audit-only marker. The renter's balance is NOT touched here — funds
      // were already debited when the rental started. This documents what is
      // on hold pending admin review (or auto-release to renter in 24h).
      const cancelNote = cancelFeeD > 0
        ? ` Cancellation fee $${cancelFeeD.toFixed(6)} (${cancelFeePctD}% of elapsed) deducted from frozen.`
        : " No cancellation fee (rig was completely offline).";
      await tx.insert(walletTransactionsTable).values({
        userId: rental.renterId,
        type: "rental_dispute",
        amountUsd: "0.000000",
        balanceAfterUsd: toUsdString(0),
        memo: `Frozen $${frozenAmount.toFixed(6)} pending admin review — delivered ${Math.round(deliveryRatio * 100)}% of advertised hashrate (below ${Math.round(FULL_DELIVERY_THRESHOLD * 100)}% threshold). Owner received delivered portion ($${ownerDeliveredPayout.toFixed(6)}).${cancelNote} Auto-refunds to renter in 24h if unresolved.`,
        relatedRentalId: rental.id,
      });
      return;
    }

    // Clean cancellation path: delivery met the threshold, so we treat the
    // rig as having performed and bill on time-used only. Renter pays for
    // elapsed time, owner earns for elapsed time. No "delivery × time"
    // double-discount, and no >100% bonus from a deliveryRatio that was
    // clipped at 1.05.
    const totalSeconds =
      (rental.endsAt.getTime() - rental.startedAt.getTime()) / 1000;
    const usedSeconds = Math.max(
      0,
      Math.min(totalSeconds, (now.getTime() - rental.startedAt.getTime()) / 1000),
    );
    const usedRatio = totalSeconds > 0 ? usedSeconds / totalSeconds : 1;
    const ownerPayout = round6(toNum(rental.ownerEarningsUsd) * usedRatio);
    const grossRefund = round6(toNum(rental.renterTotalUsd) * (1 - usedRatio));

    // Cancellation penalty: withheld from the renter for voluntarily ending
    // the rental early (renter's choice, rig was delivering fine ≥ 95%).
    // Calculated on the ELAPSED cost so it's proportional to service received.
    // Penalty goes to the platform (added to platformFeeUsd).
    // Disputed cancels (rig fault, delivery < 95%) never reach this path.
    const c = await getCommission();
    const cancelFeePct = Math.max(0, Math.min(100, c.cancellationFeePct));
    const elapsedCost = round6(toNum(rental.renterTotalUsd) * usedRatio);
    const cancelFee = round6(elapsedCost * (cancelFeePct / 100));
    const renterRefund = round6(grossRefund - cancelFee);

    // Set platformFeeUsd to actual earned: elapsed share of contracted fee
    // plus the voluntary-cancel penalty.
    const actualFee = round6(toNum(rental.platformFeeUsd) * usedRatio + cancelFee);
    await tx
      .update(rentalsTable)
      .set({ platformFeeUsd: toUsdString(actualFee) })
      .where(eq(rentalsTable.id, rental.id));

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
          memo: cancelFee > 0
            ? `Refund for cancelled rental #${rental.id} (used ${Math.round(usedRatio * 100)}% of booked time; $${cancelFee.toFixed(6)} cancellation fee at ${cancelFeePct}%)`
            : `Refund for cancelled rental #${rental.id} (used ${Math.round(usedRatio * 100)}% of booked time)`,
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
          memo: `Payout for cancelled rental #${rental.id} (${Math.round(usedRatio * 100)}% of booked time used, delivery ${Math.round(deliveryRatio * 100)}%)`,
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
  // Deactivate ALL live sessions for this rental (multiple devices on same rigId).
  const deactivateSessions = proxyState.getSessionsByRentalId(rental.id);
  if (deactivateSessions.length > 0) {
    for (const s of deactivateSessions) s.deactivateRental();
  } else {
    const fallback = proxyState.getRigSession(rental.rigId);
    if (fallback) {
      fallback.deactivateRental();
    } else {
      // No live session — flush any unflushed share counters into the rentals
      // row, then clean up the share window so the flush loop stops inserting
      // samples for this finished rental.
      await flushAndRemoveRentalWindow(rental.id);
    }
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

  // Sum refunds per rental so we can show actual amount paid
  // (renterTotal − refunds). Cancelled / disputed rentals partially refund
  // the renter, so the original `renterTotalUsd` overstates what they spent.
  const rentalIds = rows.map((r) => r.id);
  const refundRows = rentalIds.length
    ? await db
        .select({
          rentalId: walletTransactionsTable.relatedRentalId,
          total: sql<string>`COALESCE(SUM(${walletTransactionsTable.amountUsd}), 0)`,
        })
        .from(walletTransactionsTable)
        .where(
          and(
            eq(walletTransactionsTable.userId, req.currentUser!.id),
            eq(walletTransactionsTable.type, "rental_refund"),
            inArray(walletTransactionsTable.relatedRentalId, rentalIds),
          ),
        )
        .groupBy(walletTransactionsTable.relatedRentalId)
    : [];
  const refundMap = new Map<number, number>();
  for (const r of refundRows) {
    if (r.rentalId != null) refundMap.set(r.rentalId, toNum(r.total));
  }

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
      netPaidUsd: round6(
        Math.max(0, toNum(r.renterTotalUsd) - (refundMap.get(r.id) ?? 0)),
      ),
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
