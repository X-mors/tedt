import { Router, type IRouter } from "express";
import { desc, eq, inArray, sql } from "drizzle-orm";
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
} from "@workspace/api-zod";
import { requireAuth } from "../lib/auth";
import { getCommission } from "../lib/commission";
import { round2, round6, toNum, toUsdString } from "../lib/money";
import { settleExpiredRentals } from "../lib/settlement";
import { randomBytes } from "node:crypto";

const router: IRouter = Router();

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
  const host = process.env["REPLIT_DEV_DOMAIN"] ?? "rigmarket.local";
  return {
    stratumProxyUrl: `stratum+tcp://${host}:33333`,
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
          sql`${rigsTable.id} = ${body.rigId} AND ${rigsTable.status} = 'available' AND ${rigsTable.approvalStatus} = 'approved'`,
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

  res.status(201).json(await loadRentalDetail(rentalId));
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
    })
    .from(rentalsTable)
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
  const advertisedHashrate = toNum(rental.hashrate);

  const dbSamples = await db
    .select({
      sampledAt: rentalHashSamplesTable.sampledAt,
      effectiveHashrateH: rentalHashSamplesTable.effectiveHashrateH,
    })
    .from(rentalHashSamplesTable)
    .where(eq(rentalHashSamplesTable.rentalId, id))
    .orderBy(desc(rentalHashSamplesTable.sampledAt))
    .limit(30);

  const samples = dbSamples.reverse().map((s) => ({
    timestamp: s.sampledAt.toISOString(),
    hashrate: toNum(s.effectiveHashrateH ?? "0"),
  }));

  const avgDeliveredH =
    samples.length > 0
      ? samples.reduce((sum, s) => sum + s.hashrate, 0) / samples.length
      : 0;
  const advertisedH = advertisedHashrate;
  const deliveryRatio =
    advertisedH > 0 && avgDeliveredH > 0
      ? Math.min(1.05, avgDeliveredH / advertisedH)
      : 0;

  let message: string | null = null;
  if (rental.status === "active" && !live.minerConnected) {
    message = "Awaiting miner connection — point your rig at the proxy URL.";
  } else if (rental.status === "active" && live.minerConnected && !live.upstreamConnected) {
    message = "Miner connected — establishing upstream pool connection.";
  } else if (rental.status !== "active" && samples.length === 0) {
    message = "No hashrate data recorded for this rental.";
  }

  const data = GetRentalStatsResponse.parse({
    rentalId: rental.id,
    currentHashrate: live.effectiveHashrateH,
    averageHashrate: avgDeliveredH,
    deliveryRatio,
    sharesAccepted: live.sharesAccepted,
    sharesRejected: live.sharesRejected,
    secondsRemaining,
    status: rental.status,
    samples,
    message,
    minerConnected: live.minerConnected,
    upstreamConnected: live.upstreamConnected,
  });
  res.json(data);
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
    const totalSeconds =
      (rental.endsAt.getTime() - rental.startedAt.getTime()) / 1000;
    const usedSeconds = Math.max(
      0,
      Math.min(
        totalSeconds,
        (now.getTime() - rental.startedAt.getTime()) / 1000,
      ),
    );
    const usedRatio = totalSeconds > 0 ? usedSeconds / totalSeconds : 1;
    const renterTotal = toNum(rental.renterTotalUsd);
    const refund = round2(renterTotal * (1 - usedRatio));

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

    await tx
      .update(rigsTable)
      .set({ status: "available" })
      .where(eq(rigsTable.id, rental.rigId));

    if (refund > 0) {
      const refundStr = toUsdString(refund);
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
          memo: `Refund for cancelled rental #${rental.id}`,
          relatedRentalId: rental.id,
        });
      }
    }

    // Owner gets a prorated payout (same logic, will be replaced by real
    // delivered-hours-based settlement once the Stratum proxy ships).
    const ownerEarningsTotal = toNum(rental.ownerEarningsUsd);
    const ownerPayout = round2(ownerEarningsTotal * usedRatio);
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
          memo: `Prorated payout for cancelled rental #${rental.id}`,
          relatedRentalId: rental.id,
        });
      }
    }
  });

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
