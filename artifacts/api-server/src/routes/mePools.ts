import { Router, type IRouter } from "express";
import { and, asc, eq } from "drizzle-orm";
import { db, userPoolsTable } from "@workspace/db";
import {
  CreateMyPoolBody,
  ListMyPoolsResponse,
  ListMyPoolsResponseItem,
  UpdateMyPoolBody,
  UpdateMyPoolResponse,
} from "@workspace/api-zod";
import { requireAuth } from "../lib/auth";

const router: IRouter = Router();

function serialize(pool: typeof userPoolsTable.$inferSelect) {
  return {
    id: pool.id,
    label: pool.label,
    poolUrl: pool.poolUrl,
    worker: pool.worker,
    password: pool.password,
    createdAt: pool.createdAt.toISOString(),
    updatedAt: pool.updatedAt.toISOString(),
  };
}

router.get("/me/pools", requireAuth, async (req, res) => {
  const rows = await db
    .select()
    .from(userPoolsTable)
    .where(eq(userPoolsTable.userId, req.currentUser!.id))
    .orderBy(asc(userPoolsTable.label));
  res.json(ListMyPoolsResponse.parse(rows.map(serialize)));
});

router.post("/me/pools", requireAuth, async (req, res) => {
  const body = CreateMyPoolBody.parse(req.body);
  try {
    const [created] = await db
      .insert(userPoolsTable)
      .values({
        userId: req.currentUser!.id,
        label: body.label,
        poolUrl: body.poolUrl,
        worker: body.worker,
        password: body.password ?? "x",
      })
      .returning();
    res.status(201).json(ListMyPoolsResponseItem.parse(serialize(created!)));
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as { code?: string }).code === "23505"
    ) {
      res
        .status(400)
        .json({ error: "A pool with that label already exists" });
      return;
    }
    throw err;
  }
});

router.patch("/me/pools/:id", requireAuth, async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const body = UpdateMyPoolBody.parse(req.body);
  const updates: Partial<typeof userPoolsTable.$inferInsert> = {};
  if (body.label !== undefined) updates.label = body.label;
  if (body.poolUrl !== undefined) updates.poolUrl = body.poolUrl;
  if (body.worker !== undefined) updates.worker = body.worker;
  if (body.password !== undefined) updates.password = body.password;

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "Nothing to update" });
    return;
  }

  try {
    const [updated] = await db
      .update(userPoolsTable)
      .set(updates)
      .where(
        and(
          eq(userPoolsTable.id, id),
          eq(userPoolsTable.userId, req.currentUser!.id),
        ),
      )
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Pool not found" });
      return;
    }
    res.json(UpdateMyPoolResponse.parse(serialize(updated)));
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as { code?: string }).code === "23505"
    ) {
      res
        .status(400)
        .json({ error: "A pool with that label already exists" });
      return;
    }
    throw err;
  }
});

router.delete("/me/pools/:id", requireAuth, async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const result = await db
    .delete(userPoolsTable)
    .where(
      and(
        eq(userPoolsTable.id, id),
        eq(userPoolsTable.userId, req.currentUser!.id),
      ),
    )
    .returning({ id: userPoolsTable.id });
  if (result.length === 0) {
    res.status(404).json({ error: "Pool not found" });
    return;
  }
  res.status(204).end();
});

export default router;
