import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import {
  db,
  rentalsTable,
  rigsTable,
  usersTable,
  type User,
} from "@workspace/db";
import {
  GetMeResponse,
  SyncMeResponse,
  UpdateMeBody,
  UpdateMeResponse,
  UpgradeToOwnerResponse,
} from "@workspace/api-zod";
import { ensureUserRecord, requireAuth } from "../lib/auth";
import { toNum } from "../lib/money";

const router: IRouter = Router();

async function serialize(user: User) {
  const [rigs] = await db
    .select({ c: sql<string>`COUNT(*)` })
    .from(rigsTable)
    .where(eq(rigsTable.ownerId, user.id));
  const [rentals] = await db
    .select({ c: sql<string>`COUNT(*)` })
    .from(rentalsTable)
    .where(eq(rentalsTable.renterId, user.id));
  return {
    id: user.id,
    clerkUserId: user.clerkUserId,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    balanceUsd: toNum(user.balanceUsd),
    totalDepositedUsd: toNum(user.totalDepositedUsd),
    totalEarnedUsd: toNum(user.totalEarnedUsd),
    totalSpentUsd: toNum(user.totalSpentUsd),
    rigCount: Number(rigs?.c ?? 0),
    rentalCount: Number(rentals?.c ?? 0),
    createdAt: user.createdAt.toISOString(),
    stratumUsername: user.stratumUsername ?? null,
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

export default router;
