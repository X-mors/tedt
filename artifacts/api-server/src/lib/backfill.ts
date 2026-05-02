import { randomBytes } from "node:crypto";
import { and, eq, isNull, or } from "drizzle-orm";
import { db } from "@workspace/db";
import { platformSettingsTable, rigsTable } from "@workspace/db/schema";
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
 * Historical fix: earlier versions of the admin-approval endpoint set
 * `approvalStatus = "approved"` but did NOT also set `status = "available"`,
 * leaving approved rigs stuck at the auto-create default `status = "offline"`.
 * Such rigs were visible on the marketplace (because `approvalStatus` is the
 * gating filter) but un-rentable — and showed a confusing "OFFLINE" badge
 * even when the miner was actively connected.
 *
 * The approval route now sets both fields atomically, but pre-existing rows
 * still need a one-time correction.
 *
 * IMPORTANT: this is a strictly one-time fix. `offline` is also a legitimate
 * intentional state set by owners (PATCH /me/rigs/:id) and admins
 * (PATCH /admin/rigs/:id/status). Re-running on every restart would
 * silently relist any rig the owner intentionally took offline. We use a
 * persisted marker in `platform_settings` so the bulk update runs at most
 * once per environment, regardless of restarts.
 */
const APPROVED_RIG_STATUS_BACKFILL_KEY = "backfill:approved_rig_status_v1";

export async function backfillApprovedRigStatus(): Promise<void> {
  const [marker] = await db
    .select({ key: platformSettingsTable.key })
    .from(platformSettingsTable)
    .where(eq(platformSettingsTable.key, APPROVED_RIG_STATUS_BACKFILL_KEY));

  if (marker) return;

  const result = await db
    .update(rigsTable)
    .set({ status: "available" })
    .where(
      and(
        eq(rigsTable.approvalStatus, "approved"),
        eq(rigsTable.status, "offline"),
      ),
    )
    .returning({ id: rigsTable.id, name: rigsTable.name });

  await db
    .insert(platformSettingsTable)
    .values({
      key: APPROVED_RIG_STATUS_BACKFILL_KEY,
      value: new Date().toISOString(),
    })
    .onConflictDoNothing({ target: platformSettingsTable.key });

  if (result.length === 0) {
    logger.info(
      "backfill: approved-rig-status marker set; no rows needed correction",
    );
    return;
  }

  logger.info(
    { count: result.length, rigs: result },
    "backfill: set status=available for approved rigs stuck at offline (one-time)",
  );
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
