import { randomBytes } from "node:crypto";
import { eq, or } from "drizzle-orm";
import { db } from "@workspace/db";
import { rigsTable } from "@workspace/db/schema";
import { logger } from "./logger";

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
