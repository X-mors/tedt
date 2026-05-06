import type {
  ShareSample,
  ShareWindow,
  ProxyRigEntry,
  ProxyAdminStatus,
  RecordedShare,
} from "./types";
import type { DownstreamSession } from "./downstream";
import type { UpstreamClient } from "./upstream";

interface RigConnection {
  session: DownstreamSession;
  entry: ProxyRigEntry;
}

interface ParkedUpstream {
  upstream: UpstreamClient;
  timer: NodeJS.Timeout;
}

interface RigSnapshot {
  entry: ProxyRigEntry;
  seenAt: number;
}

const RECONNECT_GRACE_MS = 60_000;

/** How long we keep a disconnected rig's last-seen entry visible to the UI. */
const RIG_SNAPSHOT_TTL_MS = 10 * 60_000;

/** Maximum age of share samples kept in the rolling buffer. */
const ROLLING_BUFFER_MS = 5 * 60_000;

/** Hard cap on samples-per-window so a runaway miner can't OOM the process. */
const ROLLING_BUFFER_MAX = 2000;

/** Window used by /live and /stats to compute the displayed hashrate. */
const LIVE_HASHRATE_LOOKBACK_MS = 2 * 60_000;

/** Window used by the 60-s DB sample writer. Shorter = more responsive samples. */
const FLUSH_SNAPSHOT_LOOKBACK_MS = 60_000;

/** Drop a fallback window if it has not received a share in this long. */
const FALLBACK_WINDOW_IDLE_TTL_MS = 30 * 60_000;

/** How often the background GC sweeps stale snapshots and idle fallback buffers. */
const GC_INTERVAL_MS = 5 * 60_000;

/**
 * Snapshot returned by flushSnapshot — kept structurally compatible with the
 * legacy ShareWindow flush payload that StratumServer._flushSamples consumes.
 */
export interface FlushSnapshot {
  rentalId: number;
  rigId: number;
  startedAt: number;
  sharesAccepted: number;
  sharesRejected: number;
  difficultySum: number;
  effectiveHashrateH: number;
  windowSeconds: number;
}

class ProxyState {
  private rigConnections = new Map<number, RigConnection>();
  private shareWindows = new Map<number, ShareWindow>();
  /** Per-rig fallback share buffer (used when no rental is active). */
  private fallbackWindows = new Map<number, ShareWindow>();
  /** Upstream pool connections kept alive during brief miner disconnects. */
  private parkedUpstreams = new Map<number, ParkedUpstream>();
  /** Fallback upstream connections kept alive during brief miner disconnects (no rental). */
  private parkedFallbacks = new Map<number, ParkedUpstream>();
  /** Last-known rig entry retained for `RIG_SNAPSHOT_TTL_MS` after disconnect
   *  so the owner UI does not flap to OFFLINE / 0 shares on transient drops. */
  private lastSeenRigEntries = new Map<number, RigSnapshot>();
  /**
   * Per-IP extranonce format hint.  When a miner disconnects after we learned
   * the pool's extranonce1 byte-length and extranonce2_size, we store those
   * values keyed by the miner's remote IP address.  On the next connection from
   * the same IP we can generate our proxy-extranonce1 with the EXACT same byte
   * length so that a later mining.set_extranonce only changes the VALUE (not the
   * size), which almost all ASIC firmwares accept.  A size change in
   * set_extranonce invalidates the coinbase template and most firmwares
   * disconnect immediately when they receive it.
   */
  private extranonceHints = new Map<string, { e1: string; e2size: number }>();
  /** Background GC handle — sweeps stale snapshots and idle fallback buffers. */
  private gcTimer: NodeJS.Timeout;

  constructor() {
    this.gcTimer = setInterval(() => this._gcSweep(), GC_INTERVAL_MS);
    // Don't keep the event loop alive solely for this sweep.
    this.gcTimer.unref();
  }

  /**
   * Periodic cleanup. Without this, lastSeenRigEntries grows unbounded for
   * any rig that disconnects and never reconnects (and is never queried by
   * the owner UI), and fallbackWindows holds buffers for rigs that may have
   * been deleted long ago. Bounded per-key but unbounded across all rig IDs
   * a long-running process has ever seen.
   */
  private _gcSweep(): void {
    const nowMs = Date.now();
    for (const [rigId, snap] of this.lastSeenRigEntries) {
      if (nowMs - snap.seenAt >= RIG_SNAPSHOT_TTL_MS) {
        this.lastSeenRigEntries.delete(rigId);
      }
    }
    for (const [rigId, w] of this.fallbackWindows) {
      const lastTsMs = w.recentSamples.length > 0
        ? w.recentSamples[w.recentSamples.length - 1]!.tsMs
        : w.createdAtMs;
      if (nowMs - lastTsMs >= FALLBACK_WINDOW_IDLE_TTL_MS) {
        this.fallbackWindows.delete(rigId);
      } else {
        // Trim stale samples even if the window itself stays alive.
        this._pruneSamples(w.recentSamples, nowMs);
      }
    }
  }

  /**
   * Drop ALL state for a rigId. Call when a rig is deleted by its owner so
   * the proxy doesn't hold a snapshot or fallback buffer for a record that
   * no longer exists in the database.
   */
  forgetRig(rigId: number): void {
    this.rigConnections.delete(rigId);
    this.lastSeenRigEntries.delete(rigId);
    this.fallbackWindows.delete(rigId);
    const pf = this.parkedFallbacks.get(rigId);
    if (pf) { clearTimeout(pf.timer); pf.upstream.destroy(); this.parkedFallbacks.delete(rigId); }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Internal helpers
  // ──────────────────────────────────────────────────────────────────────────

  private _newWindow(rentalId: number, rigId: number): ShareWindow {
    return {
      rentalId,
      rigId,
      createdAtMs: Date.now(),
      recentSamples: [],
      currentDifficulty: 1,
      lastShareAt: null,
      sharesAcceptedLifetime: 0,
      sharesRejectedLifetime: 0,
      sharesAcceptedAtLastFlush: 0,
      sharesRejectedAtLastFlush: 0,
    };
  }

  /**
   * Read the un-persisted share delta without consuming it. Used by the
   * read-side endpoints to combine the DB-persisted cumulative totals with
   * the in-memory shares received since the last flush. Clamps to ≥ 0
   * because a transient negative value (late-reject between flushes) would
   * make the live counter dip; the next flush will reconcile it on the DB
   * side via a signed delta.
   */
  peekUnflushedShareDelta(rentalId: number): {
    deltaAccepted: number;
    deltaRejected: number;
  } {
    const w = this.shareWindows.get(rentalId);
    if (!w) return { deltaAccepted: 0, deltaRejected: 0 };
    return {
      deltaAccepted: Math.max(0, w.sharesAcceptedLifetime - w.sharesAcceptedAtLastFlush),
      deltaRejected: Math.max(0, w.sharesRejectedLifetime - w.sharesRejectedAtLastFlush),
    };
  }

  /**
   * Take a snapshot of the rental's current cumulative counters for
   * persistence. Does NOT advance the flush marker — the caller MUST call
   * `advanceShareFlushMarker` only after the DB write succeeds, otherwise
   * the deltas would be silently dropped on a transient DB error or crash.
   * Signed deltas are returned so late-reject corrections (which decrement
   * sharesAcceptedLifetime) can flow through to the DB on the next flush.
   */
  snapshotShareCounters(rentalId: number): {
    acceptedSnapshot: number;
    rejectedSnapshot: number;
    deltaAccepted: number;
    deltaRejected: number;
    lastShareAt: Date | null;
  } | null {
    const w = this.shareWindows.get(rentalId);
    if (!w) return null;
    return {
      acceptedSnapshot: w.sharesAcceptedLifetime,
      rejectedSnapshot: w.sharesRejectedLifetime,
      deltaAccepted: w.sharesAcceptedLifetime - w.sharesAcceptedAtLastFlush,
      deltaRejected: w.sharesRejectedLifetime - w.sharesRejectedAtLastFlush,
      lastShareAt: w.lastShareAt,
    };
  }

  /** Advance the flush marker after the DB row was successfully updated. */
  advanceShareFlushMarker(
    rentalId: number,
    acceptedTo: number,
    rejectedTo: number,
  ): void {
    const w = this.shareWindows.get(rentalId);
    if (!w) return;
    w.sharesAcceptedAtLastFlush = acceptedTo;
    w.sharesRejectedAtLastFlush = rejectedTo;
  }

  private _pruneSamples(samples: ShareSample[], nowMs: number): void {
    const cutoff = nowMs - ROLLING_BUFFER_MS;
    while (samples.length > 0 && samples[0]!.tsMs < cutoff) samples.shift();
    while (samples.length > ROLLING_BUFFER_MAX) samples.shift();
  }

  private _calcHashrate(
    samples: ShareSample[],
    lookbackMs: number,
    nowMs: number,
  ): {
    sharesAccepted: number;
    sharesRejected: number;
    difficultySum: number;
    effectiveHashrateH: number;
    elapsedSec: number;
    oldestTsMs: number;
  } {
    const cutoff = nowMs - lookbackMs;
    let sharesAccepted = 0;
    let sharesRejected = 0;
    let difficultySum = 0;
    let oldestTsMs = nowMs;
    let foundAccepted = false;
    for (const s of samples) {
      if (s.tsMs < cutoff) continue;
      if (s.accepted) {
        sharesAccepted++;
        difficultySum += s.difficulty;
        if (!foundAccepted || s.tsMs < oldestTsMs) {
          oldestTsMs = s.tsMs;
          foundAccepted = true;
        }
      } else {
        sharesRejected++;
      }
    }
    if (!foundAccepted) {
      return {
        sharesAccepted: 0,
        sharesRejected,
        difficultySum: 0,
        effectiveHashrateH: 0,
        elapsedSec: lookbackMs / 1000,
        oldestTsMs: cutoff,
      };
    }
    const elapsedSec = Math.max(1, (nowMs - oldestTsMs) / 1000);
    const effectiveHashrateH = (difficultySum * 4294967296) / elapsedSec;
    return {
      sharesAccepted,
      sharesRejected,
      difficultySum,
      effectiveHashrateH,
      elapsedSec,
      oldestTsMs,
    };
  }

  private _appendSample(
    window: ShareWindow,
    accepted: boolean,
    difficulty: number,
    nowMs: number,
  ): ShareSample {
    const sample: ShareSample = { tsMs: nowMs, difficulty, accepted };
    window.recentSamples.push(sample);
    this._pruneSamples(window.recentSamples, nowMs);
    if (accepted) {
      window.sharesAcceptedLifetime++;
      window.lastShareAt = new Date(nowMs);
    } else {
      window.sharesRejectedLifetime++;
    }
    window.currentDifficulty = difficulty;
    return sample;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Rig connection lifecycle
  // ──────────────────────────────────────────────────────────────────────────

  addRig(rigId: number, ownerId: number, session: DownstreamSession, rigName: string): void {
    // CRITICAL: if a previous session is still registered for this rigId, force
    // it to disconnect BEFORE we overwrite the map entry. Otherwise the old
    // session's upstream (e.g. owner's fallback to viabtc as `ahmed.m30`) keeps
    // mining in parallel with the new session's upstream (renter's pool as
    // `AhmadSamir.y`), producing two simultaneous TCP connections to the pool
    // and inconsistent stats. Also when the orphaned old session eventually
    // closes, its _onClose calls removeRig(rigId) and accidentally evicts the
    // NEW session's entry from the map.
    const existing = this.rigConnections.get(rigId);
    if (existing && existing.session !== session) {
      existing.session.disconnect("replaced by new connection for same rigId");
    }
    // If we have a recent snapshot for this rigId, restore lifetime counters
    // so a quick reconnect doesn't reset shares-accepted/rejected display.
    const snap = this.lastSeenRigEntries.get(rigId);
    const restored =
      snap && Date.now() - snap.seenAt < RIG_SNAPSHOT_TTL_MS ? snap.entry : null;
    this.rigConnections.set(rigId, {
      session,
      entry: {
        rigId,
        ownerId,
        rigName,
        connectedAt: new Date(),
        authorized: false,
        rentalId: null,
        sharesAccepted: restored?.sharesAccepted ?? 0,
        sharesRejected: restored?.sharesRejected ?? 0,
        lastShareAt: restored?.lastShareAt ?? null,
        upstreamConnected: false,
        upstreamAuthFailed: false,
        submitsDropped: 0,
        upstreamErrors: 0,
        upstreamDisconnects: 0,
      },
    });
    // Drop the snapshot now that the live entry has taken over.
    this.lastSeenRigEntries.delete(rigId);
  }

  incrementDropped(rigId: number): void {
    const conn = this.rigConnections.get(rigId);
    if (conn) conn.entry.submitsDropped++;
  }

  incrementUpstreamError(rigId: number): void {
    const conn = this.rigConnections.get(rigId);
    if (conn) conn.entry.upstreamErrors++;
  }

  incrementUpstreamDisconnect(rigId: number): void {
    const conn = this.rigConnections.get(rigId);
    if (conn) conn.entry.upstreamDisconnects++;
  }

  removeRig(rigId: number, session?: DownstreamSession): void {
    const conn = this.rigConnections.get(rigId);
    // Guard against the orphaned-session race: if a previous session for the
    // same rigId is closing AFTER a new session has already taken over the
    // map entry, do nothing — otherwise we would evict the live session.
    if (conn && session && conn.session !== session) return;
    if (conn) {
      // Snapshot so the owner UI keeps showing share counts and lastShareAt
      // during the reconnect grace window. Mark upstream as disconnected
      // since the rig is going away.
      this.lastSeenRigEntries.set(rigId, {
        entry: {
          ...conn.entry,
          upstreamConnected: false,
          upstreamAuthFailed: false,
        },
        seenAt: Date.now(),
      });
      this.rigConnections.delete(rigId);
    }
  }

  getRigSession(rigId: number): DownstreamSession | undefined {
    return this.rigConnections.get(rigId)?.session;
  }

  /**
   * Fallback lookup: return the first connected session that belongs to `ownerId`.
   * Used when the rental's rigId doesn't match the connected rig's rigId (which
   * happens when the miner connected with a stratumName that differs from the
   * listed rig's stratumName and the proxy auto-created a shadow rig).
   */
  getAnySessionForOwner(ownerId: number): DownstreamSession | undefined {
    for (const conn of this.rigConnections.values()) {
      if (conn.entry.ownerId === ownerId) return conn.session;
    }
    return undefined;
  }

  /**
   * Like getAnySessionForOwner but only returns a session when there is
   * EXACTLY ONE idle (no active rental) session for this owner.
   * Safe to use for rental activation: if the owner has multiple connected
   * rigs we cannot determine which is the shadow rig, so we return undefined
   * to avoid activating the rental on the wrong device. The rental will be
   * picked up on the next natural reconnect via _findActiveRental.
   */
  getUnambiguousIdleSessionForOwner(ownerId: number): DownstreamSession | undefined {
    const idle: DownstreamSession[] = [];
    for (const conn of this.rigConnections.values()) {
      if (conn.entry.ownerId === ownerId && conn.entry.rentalId === null) {
        idle.push(conn.session);
      }
    }
    return idle.length === 1 ? idle[0] : undefined;
  }

  /**
   * Find the session currently routing shares for `rentalId`. This is the
   * authoritative lookup when terminating/settling a rental, because shadow
   * rigs (auto-created when miner uses a non-matching stratumName) have a
   * different rigId from rental.rigId — looking up by rigId would silently
   * miss them and leave the upstream pool connection alive, continuing to
   * mine for the renter after termination.
   */
  getSessionByRentalId(rentalId: number): DownstreamSession | undefined {
    for (const conn of this.rigConnections.values()) {
      if (conn.entry.rentalId === rentalId) return conn.session;
    }
    return undefined;
  }

  setRigAuthorized(rigId: number, rentalId: number | null): void {
    const conn = this.rigConnections.get(rigId);
    if (conn) {
      conn.entry.authorized = true;
      conn.entry.rentalId = rentalId;
    }
  }

  setUpstreamConnected(rigId: number, connected: boolean): void {
    const conn = this.rigConnections.get(rigId);
    if (conn) {
      conn.entry.upstreamConnected = connected;
      if (connected) conn.entry.upstreamAuthFailed = false;
    }
  }

  setUpstreamAuthFailed(rigId: number, failed: boolean): void {
    const conn = this.rigConnections.get(rigId);
    if (conn) conn.entry.upstreamAuthFailed = failed;
  }

  /**
   * Returns fallback pool connection status only when the rig is connected and
   * NOT currently in an active rental (i.e. miner is running in fallback mode).
   * Returns null when the rig is offline or when a rental is active.
   */
  getFallbackPoolStatus(rigId: number): { connected: boolean; authFailed: boolean } | null {
    const conn = this.rigConnections.get(rigId);
    if (!conn) return null;
    if (conn.entry.rentalId !== null) return null;
    return {
      connected: conn.entry.upstreamConnected,
      authFailed: conn.entry.upstreamAuthFailed,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Share recording — rental and fallback
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Record a share for an active rental. Returns a `RecordedShare` handle
   * that captures the rentalId/rigId at record time so a later
   * `markShareRejected` correction routes to the SAME window/connection
   * even if the rig disconnects, the rental ends, or the mode flips while
   * the upstream pool reply is still in flight. Returns null only when the
   * rig connection has gone away entirely.
   */
  recordShare(
    rigId: number,
    accepted: boolean,
    difficulty: number,
  ): RecordedShare | null {
    const conn = this.rigConnections.get(rigId);
    if (!conn) return null;
    const nowMs = Date.now();
    if (accepted) {
      conn.entry.sharesAccepted++;
      conn.entry.lastShareAt = new Date(nowMs);
    } else {
      conn.entry.sharesRejected++;
    }

    const rentalId = conn.entry.rentalId;
    if (rentalId == null) {
      // No rental window yet (rare auth race); still return a handle so the
      // caller can roll back the conn.entry increment if the pool rejects.
      // The orphan sample isn't in any buffer — mutating its `accepted` flag
      // is a no-op for hashrate, which is the desired behaviour.
      return {
        sample: { tsMs: nowMs, difficulty, accepted },
        rigId,
        rentalId: null,
        appended: false,
      };
    }

    let window = this.shareWindows.get(rentalId);
    if (!window) {
      window = this._newWindow(rentalId, rigId);
      this.shareWindows.set(rentalId, window);
    }
    const sample = this._appendSample(window, accepted, difficulty, nowMs);
    return { sample, rigId, rentalId, appended: true };
  }

  /**
   * Downgrade a previously-recorded accepted share to rejected. Used when we
   * optimistically credit a share at submit time (downstream truth) but the
   * upstream pool eventually returns a rejection.
   *
   * Routing uses the IMMUTABLE scope captured in the handle, NOT the rig's
   * current rental/mode state — so a correction that lands after the rental
   * ended or after the rig flipped to fallback still adjusts the original
   * window, never the wrong one.
   */
  markShareRejected(handle: RecordedShare): void {
    if (!handle.sample.accepted) return;
    handle.sample.accepted = false;

    const conn = this.rigConnections.get(handle.rigId);
    if (conn) {
      if (conn.entry.sharesAccepted > 0) conn.entry.sharesAccepted--;
      conn.entry.sharesRejected++;
    }

    if (!handle.appended) return;

    if (handle.rentalId != null) {
      const window = this.shareWindows.get(handle.rentalId);
      if (window) {
        if (window.sharesAcceptedLifetime > 0) window.sharesAcceptedLifetime--;
        window.sharesRejectedLifetime++;
      }
    } else {
      const window = this.fallbackWindows.get(handle.rigId);
      if (window) {
        if (window.sharesAcceptedLifetime > 0) window.sharesAcceptedLifetime--;
        window.sharesRejectedLifetime++;
      }
    }
  }

  /**
   * Track shares submitted while the rig is in fallback mode (no active
   * rental). These shares go to the OWNER's pool and are not part of any
   * rental accounting, but we still buffer them so the owner UI can show
   * a meaningful "current hashrate" for an idle rig.
   */
  recordFallbackShare(
    rigId: number,
    accepted: boolean,
    difficulty: number,
  ): RecordedShare | null {
    const conn = this.rigConnections.get(rigId);
    const nowMs = Date.now();
    if (conn) {
      if (accepted) {
        conn.entry.sharesAccepted++;
        conn.entry.lastShareAt = new Date(nowMs);
      } else {
        conn.entry.sharesRejected++;
      }
    }
    let window = this.fallbackWindows.get(rigId);
    if (!window) {
      window = this._newWindow(0, rigId);
      this.fallbackWindows.set(rigId, window);
    }
    const sample = this._appendSample(window, accepted, difficulty, nowMs);
    return { sample, rigId, rentalId: null, appended: true };
  }

  setCurrentDifficulty(rentalId: number, difficulty: number): void {
    const window = this.shareWindows.get(rentalId);
    if (window) window.currentDifficulty = difficulty;
  }

  initShareWindow(rentalId: number, rigId: number): void {
    if (!this.shareWindows.has(rentalId)) {
      this.shareWindows.set(rentalId, this._newWindow(rentalId, rigId));
    }
  }

  /**
   * Remove a share window and any associated parked upstream when a rental
   * ends (completed, cancelled, or auto-cancelled). Stops the flush loop from
   * inserting further samples for the finished rental.
   */
  removeShareWindow(rentalId: number): void {
    this.shareWindows.delete(rentalId);
    const parked = this.parkedUpstreams.get(rentalId);
    if (parked) {
      clearTimeout(parked.timer);
      parked.upstream.destroy();
      this.parkedUpstreams.delete(rentalId);
    }
  }

  removeFallbackWindow(rigId: number): void {
    this.fallbackWindows.delete(rigId);
  }

  /**
   * Compute a 60-s snapshot of the rental's rolling buffer for DB persistence.
   * Does NOT mutate the buffer — samples roll naturally by age. Returns a
   * shape compatible with the legacy ShareWindow flush payload so the
   * StratumServer flush loop is unchanged.
   */
  flushSnapshot(rentalId: number): FlushSnapshot | null {
    const window = this.shareWindows.get(rentalId);
    if (!window) return null;
    const nowMs = Date.now();
    const calc = this._calcHashrate(
      window.recentSamples,
      FLUSH_SNAPSHOT_LOOKBACK_MS,
      nowMs,
    );
    return {
      rentalId,
      rigId: window.rigId,
      // startedAt is the wall-clock anchor for this snapshot's elapsed window
      // — server.ts recomputes effectiveHashrateH from (difficultySum, elapsed).
      startedAt: nowMs - calc.elapsedSec * 1000,
      sharesAccepted: calc.sharesAccepted,
      sharesRejected: calc.sharesRejected,
      difficultySum: calc.difficultySum,
      effectiveHashrateH: calc.effectiveHashrateH,
      windowSeconds: Math.round(calc.elapsedSec),
    };
  }

  /**
   * Backwards-compatible alias retained for any caller that still references
   * the old name. The "AndReset" suffix is now historical — the rolling
   * buffer is never reset; samples age out naturally.
   */
  flushAndResetWindow(rentalId: number): FlushSnapshot | null {
    return this.flushSnapshot(rentalId);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Live read-side helpers
  // ──────────────────────────────────────────────────────────────────────────

  getLiveStats(rentalId: number): {
    minerConnected: boolean;
    upstreamConnected: boolean;
    poolAuthFailed: boolean;
    sharesAccepted: number;
    sharesRejected: number;
    lastShareAt: Date | null;
    currentDifficulty: number;
    effectiveHashrateH: number;
  } {
    const window = this.shareWindows.get(rentalId);
    const conn = Array.from(this.rigConnections.values()).find(
      (c) => c.entry.rentalId === rentalId,
    );
    if (!window) {
      return {
        minerConnected: conn != null,
        upstreamConnected: conn?.entry.upstreamConnected ?? false,
        poolAuthFailed: conn?.entry.upstreamAuthFailed ?? false,
        sharesAccepted: 0,
        sharesRejected: 0,
        lastShareAt: null,
        currentDifficulty: 1,
        effectiveHashrateH: 0,
      };
    }
    const calc = this._calcHashrate(
      window.recentSamples,
      LIVE_HASHRATE_LOOKBACK_MS,
      Date.now(),
    );
    return {
      minerConnected: conn != null,
      upstreamConnected: conn?.entry.upstreamConnected ?? false,
      poolAuthFailed: conn?.entry.upstreamAuthFailed ?? false,
      sharesAccepted: window.sharesAcceptedLifetime,
      sharesRejected: window.sharesRejectedLifetime,
      lastShareAt: window.lastShareAt,
      currentDifficulty: window.currentDifficulty,
      effectiveHashrateH: calc.effectiveHashrateH,
    };
  }

  /**
   * Effective hashrate for a rig running in fallback mode (no rental).
   * Computed from the rolling fallback buffer over the standard 2-minute
   * lookback. Returns 0 if no recent fallback shares.
   */
  getFallbackHashrateH(rigId: number): number {
    const w = this.fallbackWindows.get(rigId);
    if (!w) return 0;
    return this._calcHashrate(
      w.recentSamples,
      LIVE_HASHRATE_LOOKBACK_MS,
      Date.now(),
    ).effectiveHashrateH;
  }

  getFallbackLastShareAt(rigId: number): Date | null {
    return this.fallbackWindows.get(rigId)?.lastShareAt ?? null;
  }

  getAllWindows(): ShareWindow[] {
    return Array.from(this.shareWindows.values());
  }

  /**
   * Snapshot the rig's fallback (no-rental) window over the standard
   * 60-second flush lookback. Used by the stratum flush loop to persist a
   * per-rig hashrate sample even when the rig is mining to its owner pool
   * (no rental). Returns null if no fallback window exists for this rig.
   */
  flushFallbackSnapshot(rigId: number): FlushSnapshot | null {
    const w = this.fallbackWindows.get(rigId);
    if (!w) return null;
    const nowMs = Date.now();
    const calc = this._calcHashrate(
      w.recentSamples,
      FLUSH_SNAPSHOT_LOOKBACK_MS,
      nowMs,
    );
    return {
      rentalId: 0,
      rigId,
      startedAt: nowMs - calc.elapsedSec * 1000,
      sharesAccepted: calc.sharesAccepted,
      sharesRejected: calc.sharesRejected,
      difficultySum: calc.difficultySum,
      effectiveHashrateH: calc.effectiveHashrateH,
      windowSeconds: Math.round(calc.elapsedSec),
    };
  }

  /** Rig IDs that currently have a fallback window (idle mining buffer). */
  getFallbackRigIds(): number[] {
    return Array.from(this.fallbackWindows.keys());
  }

  getAdminStatus(): ProxyAdminStatus {
    const entries = Array.from(this.rigConnections.values()).map(
      (c) => c.entry,
    );
    const activeRoutes = entries.filter((e) => e.upstreamConnected).length;

    const totalSharesThisSession = entries.reduce(
      (sum, e) => sum + e.sharesAccepted + e.sharesRejected,
      0,
    );

    // shares/sec computed from the rolling buffers' 2-min lookback.
    const nowMs = Date.now();
    const cutoff = nowMs - LIVE_HASHRATE_LOOKBACK_MS;
    const currentSharesPerSec = Array.from(this.shareWindows.values()).reduce(
      (sum, w) => {
        let count = 0;
        let oldest = nowMs;
        for (const s of w.recentSamples) {
          if (s.tsMs < cutoff || !s.accepted) continue;
          count++;
          if (s.tsMs < oldest) oldest = s.tsMs;
        }
        if (count === 0) return sum;
        const elapsedSec = Math.max(1, (nowMs - oldest) / 1000);
        return sum + count / elapsedSec;
      },
      0,
    );

    return {
      connectedRigs: entries,
      activeRoutes,
      totalSharesThisSession,
      currentSharesPerSec,
    };
  }

  /**
   * Return the live proxy entry for a rig if currently connected, otherwise
   * null. Used by owner-side live telemetry to show share counts and
   * connection state when no rental is active (idle fallback mining).
   */
  getRigEntry(rigId: number): ProxyRigEntry | null {
    return this.rigConnections.get(rigId)?.entry ?? null;
  }

  /**
   * Return the live entry, OR a recent snapshot taken when the rig last
   * disconnected (within RIG_SNAPSHOT_TTL_MS). The `live` flag tells the
   * caller whether the data is from an active session or a snapshot —
   * useful for grace-period UI display that should not flap to OFFLINE
   * during transient ASIC reconnects.
   */
  getRigEntryWithGrace(
    rigId: number,
  ): { entry: ProxyRigEntry; live: boolean } | null {
    const live = this.rigConnections.get(rigId);
    if (live) return { entry: live.entry, live: true };
    const snap = this.lastSeenRigEntries.get(rigId);
    if (snap) {
      if (Date.now() - snap.seenAt < RIG_SNAPSHOT_TTL_MS) {
        return { entry: snap.entry, live: false };
      }
      this.lastSeenRigEntries.delete(rigId);
    }
    return null;
  }

  getConnectedRigIds(): number[] {
    return Array.from(this.rigConnections.keys());
  }

  /** Return the distinct set of ownerIds for all currently-connected miners. */
  getConnectedOwnerIds(): number[] {
    const ownerIds = new Set<number>();
    for (const conn of this.rigConnections.values()) {
      ownerIds.add(conn.entry.ownerId);
    }
    return Array.from(ownerIds);
  }

  /**
   * Return one (ownerId, rigName) pair per currently-connected miner session.
   * The online-sync loop uses this to mark exactly the listed rigs whose
   * `stratum_name` matches what an actually-connected miner authenticated as,
   * instead of fanning out to every approved rig owned by the same user.
   */
  getConnectedRigIdentities(): Array<{ ownerId: number; rigName: string }> {
    const out: Array<{ ownerId: number; rigName: string }> = [];
    for (const conn of this.rigConnections.values()) {
      out.push({ ownerId: conn.entry.ownerId, rigName: conn.entry.rigName });
    }
    return out;
  }

  /**
   * Fallback for getFallbackPoolStatus when the miner connected as a shadow rig
   * (different ID than the listed rig).  Returns the status for the first
   * connected session owned by `ownerId` that is NOT in an active rental.
   */
  getFallbackPoolStatusByOwner(ownerId: number): { connected: boolean; authFailed: boolean } | null {
    for (const conn of this.rigConnections.values()) {
      if (conn.entry.ownerId !== ownerId) continue;
      if (conn.entry.rentalId !== null) continue;
      return {
        connected: conn.entry.upstreamConnected,
        authFailed: conn.entry.upstreamAuthFailed,
      };
    }
    return null;
  }

  forceDisconnect(rigId: number): boolean {
    const conn = this.rigConnections.get(rigId);
    if (!conn) return false;
    conn.session.disconnect("Admin forced disconnect");
    return true;
  }

  /**
   * Force-clear any parked upstream for `rentalId` so the next reconnect
   * cannot reuse a stale pool connection. MUST be called whenever the
   * rental's destination pool changes (live switch, settlement, etc.) —
   * otherwise the miner reconnects, claims the parked OLD-pool upstream
   * in `_startUpstream`, and silently keeps mining to the previous pool
   * even though the DB and UI both show the new pool.
   */
  removeParkedUpstream(rentalId: number): void {
    const parked = this.parkedUpstreams.get(rentalId);
    if (parked) {
      clearTimeout(parked.timer);
      parked.upstream.destroy();
      this.parkedUpstreams.delete(rentalId);
    }
  }

  /**
   * Park an upstream pool connection for `rentalId` during a miner reconnect
   * grace period. The upstream is automatically destroyed after RECONNECT_GRACE_MS
   * if the miner does not reconnect.
   */
  parkUpstream(rentalId: number, upstream: UpstreamClient): void {
    const existing = this.parkedUpstreams.get(rentalId);
    if (existing) {
      clearTimeout(existing.timer);
      existing.upstream.destroy();
    }
    const timer = setTimeout(() => {
      this.parkedUpstreams.get(rentalId)?.upstream.destroy();
      this.parkedUpstreams.delete(rentalId);
    }, RECONNECT_GRACE_MS);
    // Unref so the timer does not prevent process exit.
    timer.unref();
    this.parkedUpstreams.set(rentalId, { upstream, timer });
  }

  /**
   * Claim a parked upstream for reuse when the miner reconnects within the
   * grace window. Returns null if no parked upstream exists.
   */
  claimParkedUpstream(rentalId: number): UpstreamClient | null {
    const parked = this.parkedUpstreams.get(rentalId);
    if (!parked) return null;
    clearTimeout(parked.timer);
    this.parkedUpstreams.delete(rentalId);
    return parked.upstream;
  }

  /**
   * Park a fallback (no-rental) upstream for `rigId` during a miner reconnect
   * grace period so the next session can reuse the stable extranonce without
   * opening a new pool connection.
   */
  parkFallbackUpstream(rigId: number, upstream: UpstreamClient): void {
    const existing = this.parkedFallbacks.get(rigId);
    if (existing) {
      clearTimeout(existing.timer);
      existing.upstream.destroy();
    }
    const timer = setTimeout(() => {
      this.parkedFallbacks.get(rigId)?.upstream.destroy();
      this.parkedFallbacks.delete(rigId);
    }, RECONNECT_GRACE_MS);
    timer.unref();
    this.parkedFallbacks.set(rigId, { upstream, timer });
  }

  /**
   * Claim a parked fallback upstream. Returns null if none exists.
   */
  claimFallbackUpstream(rigId: number): UpstreamClient | null {
    const parked = this.parkedFallbacks.get(rigId);
    if (!parked) return null;
    clearTimeout(parked.timer);
    this.parkedFallbacks.delete(rigId);
    return parked.upstream;
  }

  /** Remove a parked fallback upstream (call when rig reloads its pool config). */
  removeParkedFallbackUpstream(rigId: number): void {
    const parked = this.parkedFallbacks.get(rigId);
    if (parked) {
      clearTimeout(parked.timer);
      parked.upstream.destroy();
      this.parkedFallbacks.delete(rigId);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Per-IP extranonce format hints
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Persist the pool's extranonce format for a miner IP so future connections
   * from the same machine can generate a proxy-extranonce1 of the correct byte
   * length, avoiding size changes in subsequent set_extranonce calls.
   */
  storeExtranonceHint(ip: string, e1: string, e2size: number): void {
    // Store the pool's full extranonce1 VALUE so the next subscribe reply can
    // use it verbatim — making set_extranonce unnecessary on that session.
    this.extranonceHints.set(ip, { e1, e2size });
  }

  /** Return the stored extranonce hint for an IP, or null if unknown. */
  getExtranonceHint(ip: string): { e1: string; e2size: number } | null {
    return this.extranonceHints.get(ip) ?? null;
  }
}

export const proxyState = new ProxyState();
