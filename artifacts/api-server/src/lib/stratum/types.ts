export interface JsonRpcMessage {
  id: number | string | null;
  method?: string;
  params?: unknown[];
  result?: unknown;
  error?: unknown;
}

/**
 * Single share sample stored in the rolling buffer. Each ASIC submit produces
 * one of these. Buffer is bounded by both wall-clock age and total count.
 */
export interface ShareSample {
  tsMs: number;
  difficulty: number;
  accepted: boolean;
}

/**
 * Handle returned by `recordShare` / `recordFallbackShare`. Captures the
 * scope at record time so a later `markShareRejected` correction routes to
 * the SAME window the sample was appended to, even if the rig's
 * rental/mode/connection has changed during the in-flight pool reply.
 *
 * `rentalId` is the immutable scope tag:
 *   • number  → sample is in the rental window for that rentalId
 *   • null    → sample is in the rig's fallback window
 */
export interface RecordedShare {
  sample: ShareSample;
  /** Unique session identifier — immutable scope tag for markShareRejected routing. */
  sessionId: string;
  rigId: number;
  rentalId: number | null;
  /** True if the sample was actually appended to a buffer. False means the
   *  conn.entry display counter was incremented but no rental window existed
   *  at record time (rare teardown race) — markShareRejected then only
   *  rolls back the conn.entry increment. */
  appended: boolean;
}

/**
 * Per-rental share tracking, redesigned around a rolling buffer of recent
 * shares. Effective hashrate is computed from samples within a configurable
 * lookback window (default 2 min for live display, 60 s for DB snapshots).
 *
 * Why a rolling buffer instead of flush-and-reset:
 *   The previous design reset difficultySum and startedAt every 60 s. Within
 *   ~30 s of a reset effectiveHashrateH was always 0 (no samples yet),
 *   producing a periodic "stuck at 0" UI artifact. Worse, ASIC firmwares
 *   reconnect every 1-2 min for keepalive, and any reset that landed inside
 *   a reconnect gap left the window starved for the entire next minute.
 *   The rolling buffer carries shares across both flushes and reconnects
 *   so the live hashrate reflects actual recent mining at all times.
 *
 * Memory: bounded to ROLLING_BUFFER_MAX samples × ~24 bytes ≈ 24 KB / rental.
 * Pruned by age (ROLLING_BUFFER_MS) to discard stale data.
 */
export interface ShareWindow {
  rentalId: number;
  rigId: number;
  /** Wall-clock time when the window was first created (cumulative anchor). */
  createdAtMs: number;
  /** Rolling buffer of recent share samples, oldest first. */
  recentSamples: ShareSample[];
  /** Latest difficulty the upstream pool has set on this session. */
  currentDifficulty: number;
  /** Most recent accepted-share timestamp — used by display-stability grace. */
  lastShareAt: Date | null;
  /** Cumulative totals for this in-memory window. Reset to 0 when the server
   *  restarts — durable totals live on the rentals row in the DB. */
  sharesAcceptedLifetime: number;
  sharesRejectedLifetime: number;
  /** Marker of how many shares have already been persisted to the rentals row
   *  via the flush loop. The flush loop updates the DB with
   *  (sharesAcceptedLifetime − sharesAcceptedAtLastFlush) and then advances
   *  the marker. This prevents double-counting across flushes. */
  sharesAcceptedAtLastFlush: number;
  sharesRejectedAtLastFlush: number;
}

export interface ProxyRigEntry {
  /** Unique per-connection identifier — never changes, even if rigId does. */
  sessionId: string;
  rigId: number;
  /** Database ownerId — used to locate a session when rigId lookup misses due to stratumName mismatch. */
  ownerId: number;
  rigName: string;
  connectedAt: Date;
  authorized: boolean;
  rentalId: number | null;
  sharesAccepted: number;
  sharesRejected: number;
  lastShareAt: Date | null;
  upstreamConnected: boolean;
  /** True when the upstream pool rejected mining.authorize (wrong worker/password) */
  upstreamAuthFailed: boolean;
  /** Number of mining.submit messages that were buffered and dropped (buffer full) */
  submitsDropped: number;
  /** Number of upstream connection errors observed for this session */
  upstreamErrors: number;
  /** Number of times the upstream disconnected / was lost during this session */
  upstreamDisconnects: number;
  /** Latest pool-set difficulty for this specific session (set by mining.set_difficulty). */
  currentDifficulty: number;
}

export interface ProxyAdminStatus {
  connectedRigs: ProxyRigEntry[];
  activeRoutes: number;
  /** Cumulative accepted+rejected share count across all connected rig sessions */
  totalSharesThisSession: number;
  /** Estimated shares/sec computed from the rolling share windows */
  currentSharesPerSec: number;
}
