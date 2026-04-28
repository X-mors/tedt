import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import {
  db,
  rentalsTable,
  rigsTable,
  usersTable,
  type User,
} from "@workspace/db";
import {
  GetMeResponse,
  ResetStratumTokenResponse,
  SyncMeResponse,
  UpdateMeBody,
  UpdateMeResponse,
  UpgradeToOwnerResponse,
} from "@workspace/api-zod";
import { ensureUserRecord, requireAuth } from "../lib/auth";
import { toNum } from "../lib/money";

const router: IRouter = Router();

async function ensureStratumToken(user: User): Promise<User> {
  if (user.stratumToken) return user;
  const token = randomBytes(32).toString("hex");
  const [updated] = await db
    .update(usersTable)
    .set({ stratumToken: token })
    .where(eq(usersTable.id, user.id))
    .returning();
  return updated ?? user;
}

async function serialize(user: User) {
  const hydratedUser = await ensureStratumToken(user);
  const [rigs] = await db
    .select({ c: sql<string>`COUNT(*)` })
    .from(rigsTable)
    .where(eq(rigsTable.ownerId, hydratedUser.id));
  const [rentals] = await db
    .select({ c: sql<string>`COUNT(*)` })
    .from(rentalsTable)
    .where(eq(rentalsTable.renterId, hydratedUser.id));
  return {
    id: hydratedUser.id,
    clerkUserId: hydratedUser.clerkUserId,
    email: hydratedUser.email,
    displayName: hydratedUser.displayName,
    role: hydratedUser.role,
    balanceUsd: toNum(hydratedUser.balanceUsd),
    totalDepositedUsd: toNum(hydratedUser.totalDepositedUsd),
    totalEarnedUsd: toNum(hydratedUser.totalEarnedUsd),
    totalSpentUsd: toNum(hydratedUser.totalSpentUsd),
    rigCount: Number(rigs?.c ?? 0),
    rentalCount: Number(rentals?.c ?? 0),
    createdAt: hydratedUser.createdAt.toISOString(),
    stratumUsername: hydratedUser.stratumUsername ?? null,
    stratumToken: hydratedUser.stratumToken ?? null,
  };
}

router.get("/me", requireAuth, async (req, res) => {
  const data = GetMeResponse.parse(await serialize(req.currentUser!));
  res.json(data);
});

router.patch("/me", requireAuth, async (req, res) => {
  const body = UpdateMeBody.parse(req.body);
  const updates: Partial<typeof usersTable.$inferInsert> = {};

  if (body.displayName !== undefined) {
    updates.displayName = body.displayName;
  }

  if (body.stratumUsername !== undefined) {
    const slug = body.stratumUsername.toLowerCase();
    const [existing] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.stratumUsername, slug));
    if (existing && existing.id !== req.currentUser!.id) {
      res.status(400).json({ error: "That username is already taken" });
      return;
    }
    updates.stratumUsername = slug;
  }

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "Nothing to update" });
    return;
  }

  const [updated] = await db
    .update(usersTable)
    .set(updates)
    .where(eq(usersTable.id, req.currentUser!.id))
    .returning();
  const data = UpdateMeResponse.parse(await serialize(updated!));
  res.json(data);
});

router.post("/me/upgrade-to-owner", requireAuth, async (req, res) => {
  const user = req.currentUser!;
  if (user.role !== "renter") {
    res.status(400).json({ error: "Account is already an owner or admin" });
    return;
  }
  const [updated] = await db
    .update(usersTable)
    .set({ role: "owner" })
    .where(eq(usersTable.id, user.id))
    .returning();
  const data = UpgradeToOwnerResponse.parse(await serialize(updated!));
  res.json(data);
});

router.post("/me/sync", async (req, res) => {
  const user = await ensureUserRecord(req);
  if (!user) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
  const data = SyncMeResponse.parse(await serialize(user));
  res.json(data);
});

router.post("/me/stratum-token/reset", requireAuth, async (req, res) => {
  const newToken = randomBytes(32).toString("hex");
  const [updated] = await db
    .update(usersTable)
    .set({ stratumToken: newToken })
    .where(eq(usersTable.id, req.currentUser!.id))
    .returning();
  const data = ResetStratumTokenResponse.parse(await serialize(updated!));
  res.json(data);
});

export default router;
