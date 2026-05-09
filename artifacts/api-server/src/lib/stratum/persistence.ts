import { eq, sql } from "drizzle-orm";
import { db, rentalsTable } from "@workspace/db";
import { logger } from "../logger";
import { proxyState } from "./state";

/**
 * Per-rental mutex preventing concurrent share-counter persistence. We store
 * the in-flight Promise (not just a bool) so concurrent callers can AWAIT
 * the active write rather than skipping — a skip would let teardown drop
 * the window while the periodic flush is still mid-write, and a transient
 * DB failure on that write would silently lose the deltas with no window
 * left to retry from.
 */
const sharePersistInFlight = new Map<number, Promise<void>>();

async function _persistOnce(rentalId: number): Promise<void> {
  const snap = proxyState.snapshotShareCounters(rentalId);
  if (!snap) return;
  const noChange =
    snap.deltaAccepted === 0 &&
    snap.deltaRejected === 0 &&
    snap.lastShareAt == null;
  if (noChange) return;
  try {
    const updates: Record<string, unknown> = {};
    if (snap.deltaAccepted !== 0) {
      updates["sharesAccepted"] = sql`GREATEST(0, ${rentalsTable.sharesAccepted} + ${snap.deltaAccepted})`;
    }
    if (snap.deltaRejected !== 0) {
      updates["sharesRejected"] = sql`GREATEST(0, ${rentalsTable.sharesRejected} + ${snap.deltaRejected})`;
    }
    if (snap.lastShareAt) {
      updates["lastShareAt"] = snap.lastShareAt;
    }
    if (Object.keys(updates).length > 0) {
      await db
        .update(rentalsTable)
        .set(updates)
        .where(eq(rentalsTable.id, rentalId));
    }
    proxyState.advanceShareFlushMarker(
      rentalId,
      snap.acceptedSnapshot,
      snap.rejectedSnapshot,
    );
  } catch (err) {
    logger.error(
      { err, rentalId },
      "stratum:persist share-counter persist error — will retry on next flush",
    );
  }
}

/**
 * Persist the unflushed share-counter delta for `rentalId` to the rentals
 * row. Safe to call from both the periodic flush loop and rental-teardown
 * paths. Implements commit-after-success: the in-memory marker only
 * advances after the DB write succeeds, so transient errors don't drop
 * counts. Handles signed deltas (late-reject) via `GREATEST(0, x + delta)`
 * so DB counters can be decremented without going negative. If a persist
 * is already in flight for this rental, awaits it then runs another pass
 * so any deltas that accumulated during the wait are also captured.
 */
export async function persistRentalShareDelta(rentalId: number): Promise<void> {
  const inFlight = sharePersistInFlight.get(rentalId);
  if (inFlight) {
    await inFlight;
    // Continue to a fresh persist pass: more shares may have arrived (or
    // teardown corrections landed) while we were waiting.
  }
  const promise = _persistOnce(rentalId).finally(() => {
    if (sharePersistInFlight.get(rentalId) === promise) {
      sharePersistInFlight.delete(rentalId);
    }
  });
  sharePersistInFlight.set(rentalId, promise);
  await promise;
}

/**
 * Persist any unflushed share counters for `rentalId`, then remove the
 * in-memory window. Used by all rental-teardown paths (cancel, settle,
 * deactivateRental, auto-cancel) to guarantee the final ~60 s of shares
 * survive into the DB before the window is dropped.
 *
 * A microtask drain (setImmediate) runs before the snapshot so any pending
 * `markShareRejected` corrections triggered by the upstream destroy that
 * usually precedes teardown have a chance to apply to the in-memory window
 * BEFORE we capture and persist the final counts.
 */
export async function flushAndRemoveRentalWindow(rentalId: number): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await persistRentalShareDelta(rentalId);
  proxyState.removeShareWindow(rentalId);
}
