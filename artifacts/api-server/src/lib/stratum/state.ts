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
  /**
   * Primary connection index: sessionId (UUID) → RigConnection.
   * Each TCP connection has its own unique sessionId regardless of rigId.
   * Two devices with the same worker name get different sessionIds and never
   * interfere with each other.
   */
  private rigConnections = new Map<string, RigConnection>();
  /**
   * Secondary index: rigId → Set<sessionId>.
   * Allows lookups by rigId (for rental routing, admin UI, etc.) without
   * collapsing multiple sessions for the same rig into one.
   */
  private rigIdToSessionIds = new Map<number, Set<string>>();
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
   * Per-rental last-known upstream pool state, persisted across miner
   * disconnects so the flush loop can still detect pool-offline even when
   * the miner TCP session has already closed.  TTL = 10 min.
   */
  private rentalLastPoolState = new Map<
    number,
    { connected: boolean; updatedAt: number }
  >();
  /**
   * Per-rig extranonce format hint keyed by rigId.
   * Stores the pool's exact extranonce1 VALUE and extranonce2_size so the next
   * subscribe reply can use them verbatim — making set_extranonce unnecessary.
   * Using rigId (not IP) means two different rigs behind the same NAT never
   * share each other's hint, regardless of which port they connect on.
   */
  private extranonceHints = new Map<number, { e1: string; e2size: number }>();
  /**
   * Secondary index: "remoteIp:localPort" → Set<rigId>.
   * Populated after mining.authorize so that _handleSubscribe (which runs
   * BEFORE auth) can look up the rigId for a returning miner and then fetch
   * the correct extranonce hint by rigId.
   *
   * NOTE: A single IP:port key can map to MULTIPLE rigs when several physical
   * devices share the same public IP (e.g. a farm behind NAT).  We keep a Set
   * of all rigIds ever seen from that IP and, at subscribe time, pick the one
   * offline rig — so two devices on the same LAN each get their own correct
   * hint without overwriting each other.
   */
  private ipToRigIds = new Map<string, Set<number>>();
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
    // Disconnect all sessions for this rig.
    const sids = this.rigIdToSessionIds.get(rigId);
    if (sids) {
      for (const sid of sids) this.rigConnections.delete(sid);
      this.rigIdToSessionIds.delete(rigId);
    }
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

  /**
   * Register a new TCP session. Each call gets its own sessionId (UUID) so
   * multiple devices with the same rigId coexist without evicting each other.
   * No kick logic — every connection is independent.
   */
  addRig(sessionId: string, rigId: number, ownerId: number, session: DownstreamSession, rigName: string): void {
    // If we have a recent snapshot for this rigId, restore lifetime counters
    // so a quick reconnect doesn't reset shares-accepted/rejected display.
    const snap = this.lastSeenRigEntries.get(rigId);
    const restored =
      snap && Date.now() - snap.seenAt < RIG_SNAPSHOT_TTL_MS ? snap.entry : null;
    this.rigConnections.set(sessionId, {
      session,
      entry: {
        sessionId,
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
        currentDifficulty: 1,
      },
    });
    // Register sessionId in the rigId → sessionIds index.
    let sids = this.rigIdToSessionIds.get(rigId);
    if (!sids) { sids = new Set(); this.rigIdToSessionIds.set(rigId, sids); }
    sids.add(sessionId);
    // Drop the snapshot now that a live entry has taken over.
    this.lastSeenRigEntries.delete(rigId);
  }

  setSessionDifficulty(sessionId: string, difficulty: number): void {
    const conn = this.rigConnections.get(sessionId);
    if (conn) conn.entry.currentDifficulty = difficulty;
  }

  incrementDropped(sessionId: string): void {
    const conn = this.rigConnections.get(sessionId);
    if (conn) conn.entry.submitsDropped++;
  }

  incrementUpstreamError(sessionId: string): void {
    const conn = this.rigConnections.get(sessionId);
    if (conn) conn.entry.upstreamErrors++;
  }

  incrementUpstreamDisconnect(sessionId: string): void {
    const conn = this.rigConnections.get(sessionId);
    if (conn) conn.entry.upstreamDisconnects++;
  }

  removeRig(sessionId: string): void {
    const conn = this.rigConnections.get(sessionId);
    if (!conn) return;
    const rigId = conn.entry.rigId;
    // Persist the upstream pool state at the moment of disconnect so the next
    // flush cycle can detect pool-offline even though the TCP session is gone.
    if (conn.entry.rentalId != null) {
      this.rentalLastPoolState.set(conn.entry.rentalId, {
        connected: conn.entry.upstreamConnected,
        updatedAt: Date.now(),
      });
    }
    // Snapshot so the owner UI keeps showing share counts and lastShareAt
    // during the reconnect grace window.
    this.lastSeenRigEntries.set(rigId, {
      entry: { ...conn.entry, upstreamConnected: false, upstreamAuthFailed: false },
      seenAt: Date.now(),
    });
    this.rigConnections.delete(sessionId);
    const sids = this.rigIdToSessionIds.get(rigId);
    if (sids) {
      sids.delete(sessionId);
      if (sids.size === 0) this.rigIdToSessionIds.delete(rigId);
    }
  }

  /** Return the first live session for a rigId, or undefined if none connected. */
  getRigSession(rigId: number): DownstreamSession | undefined {
    const sids = this.rigIdToSessionIds.get(rigId);
    if (!sids) return undefined;
    for (const sid of sids) {
      const conn = this.rigConnections.get(sid);
      if (conn) return conn.session;
    }
    return undefined;
  }

  /** Return ALL live sessions for a rigId. */
  getRigSessions(rigId: number): DownstreamSession[] {
    const sids = this.rigIdToSessionIds.get(rigId);
    if (!sids) return [];
    const out: DownstreamSession[] = [];
    for (const sid of sids) {
      const conn = this.rigConnections.get(sid);
      if (conn) out.push(conn.session);
    }
    return out;
  }

  /**
   * Fallback lookup: return the connected session for `ownerId` only when
   * exactly ONE device is connected for that owner.  If multiple devices are
   * connected we cannot safely pick which one should receive the rental
   * activation — returning undefined forces the caller to wait for the correct
   * device to reconnect and pick up the rental via `_findActiveRental`.
   */
  getAnySessionForOwner(ownerId: number): DownstreamSession | undefined {
    const sessions: DownstreamSession[] = [];
    for (const conn of this.rigConnections.values()) {
      if (conn.entry.ownerId === ownerId) sessions.push(conn.session);
    }
    return sessions.length === 1 ? sessions[0] : undefined;
  }

  /**
   * Find the session currently routing shares for `rentalId`. This is the
   * authoritative lookup when terminating/settling a rental.
   */
  getSessionByRentalId(rentalId: number): DownstreamSession | undefined {
    for (const conn of this.rigConnections.values()) {
      if (conn.entry.rentalId === rentalId) return conn.session;
    }
    return undefined;
  }

  /**
   * Return per-worker stats for all sessions currently routing this rental.
   * Used by the /rentals/:id/live endpoint to show multi-device breakdowns.
   */
  getRentalWorkerStats(rentalId: number): Array<{
    sessionId: string;
    rigName: string;
    currentDifficulty: number;
    sharesAccepted: number;
    sharesRejected: number;
    upstreamConnected: boolean;
    connectedAt: string;
  }> {
    const out = [];
    for (const conn of this.rigConnections.values()) {
      if (conn.entry.rentalId !== rentalId) continue;
      out.push({
        sessionId: conn.entry.sessionId,
        rigName: conn.entry.rigName,
        currentDifficulty: conn.entry.currentDifficulty,
        sharesAccepted: conn.entry.sharesAccepted,
        sharesRejected: conn.entry.sharesRejected,
        upstreamConnected: conn.entry.upstreamConnected,
        connectedAt: conn.entry.connectedAt.toISOString(),
      });
    }
    return out;
  }

  /** Return ALL live sessions currently routing shares for `rentalId`. */
  getSessionsByRentalId(rentalId: number): DownstreamSession[] {
    const out: DownstreamSession[] = [];
    for (const conn of this.rigConnections.values()) {
      if (conn.entry.rentalId === rentalId) out.push(conn.session);
    }
    return out;
  }

  setRigAuthorized(sessionId: string, rentalId: number | null): void {
    const conn = this.rigConnections.get(sessionId);
    if (conn) {
      conn.entry.authorized = true;
      conn.entry.rentalId = rentalId;
      // Reset per-session share counters when a new rental activates so that
      // shares restored from the reconnect snapshot (previous rental) don't
      // bleed into the new rental's per-worker stats.
      if (rentalId !== null) {
        conn.entry.sharesAccepted = 0;
        conn.entry.sharesRejected = 0;
      }
    }
  }

  setUpstreamConnected(sessionId: string, connected: boolean): void {
    const conn = this.rigConnections.get(sessionId);
    if (conn) {
      conn.entry.upstreamConnected = connected;
      if (connected) conn.entry.upstreamAuthFailed = false;
      // Persist so the flush loop can detect pool-offline even if the miner
      // disconnects before the next 60-s sample tick.
      if (conn.entry.rentalId != null) {
        this.rentalLastPoolState.set(conn.entry.rentalId, {
          connected,
          updatedAt: Date.now(),
        });
      }
    }
  }

  setUpstreamAuthFailed(sessionId: string, failed: boolean): void {
    const conn = this.rigConnections.get(sessionId);
    if (conn) conn.entry.upstreamAuthFailed = failed;
  }

  /**
   * Returns fallback pool connection status only when the rig is connected and
   * NOT currently in an active rental (i.e. miner is running in fallback mode).
   * Returns null when the rig is offline or when a rental is active.
   * If multiple sessions exist for this rigId, returns status of first idle one.
   */
  getFallbackPoolStatus(rigId: number): { connected: boolean; authFailed: boolean } | null {
    const sids = this.rigIdToSessionIds.get(rigId);
    if (!sids) return null;
    for (const sid of sids) {
      const conn = this.rigConnections.get(sid);
      if (!conn || conn.entry.rentalId !== null) continue;
      return { connected: conn.entry.upstreamConnected, authFailed: conn.entry.upstreamAuthFailed };
    }
    return null;
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
    sessionId: string,
    accepted: boolean,
    difficulty: number,
  ): RecordedShare | null {
    const conn = this.rigConnections.get(sessionId);
    if (!conn) return null;
    const { rigId } = conn.entry;
    const nowMs = Date.now();
    if (accepted) {
      conn.entry.sharesAccepted++;
      conn.entry.lastShareAt = new Date(nowMs);
    } else {
      conn.entry.sharesRejected++;
    }

    const rentalId = conn.entry.rentalId;
    if (rentalId == null) {
      return {
        sample: { tsMs: nowMs, difficulty, accepted },
        sessionId,
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
    return { sample, sessionId, rigId, rentalId, appended: true };
  }

  markShareRejected(handle: RecordedShare): void {
    if (!handle.sample.accepted) return;
    handle.sample.accepted = false;

    // Update session counter via sessionId (immutable scope).
    const conn = this.rigConnections.get(handle.sessionId);
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

  recordFallbackShare(
    sessionId: string,
    accepted: boolean,
    difficulty: number,
  ): RecordedShare | null {
    const conn = this.rigConnections.get(sessionId);
    const nowMs = Date.now();
    const rigId = conn?.entry.rigId ?? 0;
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
    return { sample, sessionId, rigId, rentalId: null, appended: true };
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

  /**
   * Return the last-recorded upstream pool state for a rental (persisted
   * across miner disconnects).  Returns null when unknown or stale (> 10 min).
   */
  getLastKnownPoolState(rentalId: number): boolean | null {
    const s = this.rentalLastPoolState.get(rentalId);
    if (!s) return null;
    if (Date.now() - s.updatedAt > 10 * 60_000) return null;
    return s.connected;
  }

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
    // When the miner is disconnected, fall back to the last-known pool state
    // (saved in setUpstreamConnected / removeRig).  This lets the flush loop
    // write pool_offline=true even if the miner dropped its TCP session because
    // the pool was unreachable.  Default to true (pool assumed up) when unknown.
    const lastKnown = conn == null ? this.getLastKnownPoolState(rentalId) : null;
    const upstreamConnected =
      conn != null
        ? conn.entry.upstreamConnected
        : (lastKnown ?? true);
    if (!window) {
      return {
        minerConnected: conn != null,
        upstreamConnected,
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
      upstreamConnected,
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
  /** Return the first live entry for a rigId, or null. */
  getRigEntry(rigId: number): ProxyRigEntry | null {
    const sids = this.rigIdToSessionIds.get(rigId);
    if (!sids) return null;
    for (const sid of sids) {
      const conn = this.rigConnections.get(sid);
      if (conn) return conn.entry;
    }
    return null;
  }

  getRigEntryWithGrace(
    rigId: number,
  ): { entry: ProxyRigEntry; live: boolean } | null {
    const entry = this.getRigEntry(rigId);
    if (entry) return { entry, live: true };
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
    return Array.from(this.rigIdToSessionIds.keys());
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
    const sessions = this.getRigSessions(rigId);
    if (sessions.length === 0) return false;
    for (const s of sessions) s.disconnect("Admin forced disconnect");
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
  // Per-rig extranonce format hints (keyed by rigId)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Persist the pool's extranonce format keyed by rigId.
   * Called on session close so the next subscribe from the same rig can reply
   * with the correct e1 length/value and e2size — avoiding set_extranonce entirely.
   */
  storeExtranonceHint(rigId: number, e1: string, e2size: number): void {
    this.extranonceHints.set(rigId, { e1, e2size });
  }

  /** Return the stored extranonce hint for a rigId, or null if unknown. */
  getExtranonceHint(rigId: number): { e1: string; e2size: number } | null {
    return this.extranonceHints.get(rigId) ?? null;
  }

  /**
   * Record the mapping "remoteIp:localPort" → rigId after a successful auth.
   * Used by _handleSubscribe (which runs before auth) to look up the rigId
   * of a returning miner so it can fetch the correct extranonce hint.
   *
   * Adds rigId to the Set for this IP (never removes) so multiple devices
   * behind the same NAT each retain their individual rigId ↔ IP association.
   */
  storeIpRigMapping(ipPort: string, rigId: number): void {
    let set = this.ipToRigIds.get(ipPort);
    if (!set) {
      set = new Set();
      this.ipToRigIds.set(ipPort, set);
    }
    set.add(rigId);
  }

  /**
   * Return the best rigId for an extranonce hint lookup at subscribe time.
   *
   * "Best" means: the sole rigId known for this IP that currently has NO live
   * session (i.e. the device is reconnecting).  If multiple offline rigIds are
   * known (e.g. both devices just rebooted simultaneously) we cannot reliably
   * tell them apart and return undefined so each gets a fresh random extranonce
   * and goes through one force-close cycle to re-establish their hints.
   *
   * If the only known rigId IS currently live, this is a different physical
   * device sharing the same NAT IP — again return undefined so it starts fresh.
   */
  getRigIdByIp(ipPort: string): number | undefined {
    const set = this.ipToRigIds.get(ipPort);
    if (!set || set.size === 0) return undefined;
    // Collect rigIds that have NO live session right now.
    const offline: number[] = [];
    for (const id of set) {
      const sessions = this.rigIdToSessionIds.get(id);
      if (!sessions || sessions.size === 0) offline.push(id);
    }
    return offline.length === 1 ? offline[0] : undefined;
  }
}

export const proxyState = new ProxyState();
