import { randomBytes } from "node:crypto";
import { and, eq, isNull, or } from "drizzle-orm";
import { db } from "@workspace/db";
import { rigsTable } from "@workspace/db/schema";
import { logger } from "./logger";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24) || "rig";
}

async function findUniqueStratumName(ownerId: number, base: string): Promise<string> {
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

/**
 * Backfill `stratumName` for any rigs created before the field was
 * auto-populated from the rig name.
 */
export async function backfillStratumNames(): Promise<void> {
  const rigs = await db
    .select({ id: rigsTable.id, ownerId: rigsTable.ownerId, name: rigsTable.name })
    .from(rigsTable)
    .where(isNull(rigsTable.stratumName));

  if (rigs.length === 0) return;

  logger.info({ count: rigs.length }, "backfill: assigning stratumName to existing rigs");

  for (const rig of rigs) {
    const stratumName = await findUniqueStratumName(rig.ownerId, slugify(rig.name));
    await db
      .update(rigsTable)
      .set({ stratumName })
      .where(eq(rigsTable.id, rig.id));
  }

  logger.info({ count: rigs.length }, "backfill: stratumName assignment complete");
}

/**
 * Backfill `proxyToken` for any rigs that were seeded/created before the
 * token column was added (they have an empty string by default).
 */
export async function backfillRigTokens(): Promise<void> {
  const rigs = await db
    .select({ id: rigsTable.id })
    .from(rigsTable)
    .where(
      or(
        eq(rigsTable.proxyToken, ""),
      ),
    );

  if (rigs.length === 0) return;

  logger.info({ count: rigs.length }, "backfill: assigning proxyToken to existing rigs");

  for (const rig of rigs) {
    const token = randomBytes(32).toString("hex");
    await db
      .update(rigsTable)
      .set({ proxyToken: token })
      .where(eq(rigsTable.id, rig.id));
  }

  logger.info({ count: rigs.length }, "backfill: proxyToken assignment complete");
}
