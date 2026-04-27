import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import {
  GetMeResponse,
  SyncMeResponse,
  UpdateMeBody,
  UpdateMeResponse,
} from "@workspace/api-zod";
import { ensureUserRecord, requireAuth } from "../lib/auth";
import { toNum } from "../lib/money";

const router: IRouter = Router();

function serialize(user: {
  id: number;
  clerkUserId: string;
  email: string;
  displayName: string;
  role: "admin" | "owner" | "renter";
  balanceUsd: string;
  totalDepositedUsd: string;
  totalEarnedUsd: string;
  totalSpentUsd: string;
  createdAt: Date;
}) {
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
    createdAt: user.createdAt.toISOString(),
  };
}

router.get("/me", requireAuth, async (req, res) => {
  const data = GetMeResponse.parse(serialize(req.currentUser!));
  res.json(data);
});

router.patch("/me", requireAuth, async (req, res) => {
  const body = UpdateMeBody.parse(req.body);
  const [updated] = await db
    .update(usersTable)
    .set({ displayName: body.displayName })
    .where(eq(usersTable.id, req.currentUser!.id))
    .returning();
  const data = UpdateMeResponse.parse(serialize(updated!));
  res.json(data);
});

router.post("/me/sync", async (req, res) => {
  // Idempotent: ensures a local users row exists for the signed-in Clerk user.
  const user = await ensureUserRecord(req);
  if (!user) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
  const data = SyncMeResponse.parse(serialize(user));
  res.json(data);
});

export default router;
