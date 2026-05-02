import type { ShareWindow, ProxyRigEntry, ProxyAdminStatus } from "./types";
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

const RECONNECT_GRACE_MS = 60_000;

class ProxyState {
  private rigConnections = new Map<number, RigConnection>();
  private shareWindows = new Map<number, ShareWindow>();
  /** Upstream pool connections kept alive during brief miner disconnects. */
  private parkedUpstreams = new Map<number, ParkedUpstream>();

  addRig(rigId: number, ownerId: number, session: DownstreamSession, rigName: string): void {
    this.rigConnections.set(rigId, {
      session,
      entry: {
        rigId,
        ownerId,
        rigName,
        connectedAt: new Date(),
        authorized: false,
        rentalId: null,
        sharesAccepted: 0,
        sharesRejected: 0,
        lastShareAt: null,
        upstreamConnected: false,
        upstreamAuthFailed: false,
        submitsDropped: 0,
        upstreamErrors: 0,
        upstreamDisconnects: 0,
      },
    });
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

  removeRig(rigId: number): void {
    this.rigConnections.delete(rigId);
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

  recordShare(rigId: number, accepted: boolean, difficulty: number): void {
    const conn = this.rigConnections.get(rigId);
    if (!conn) return;
    if (accepted) {
      conn.entry.sharesAccepted++;
      conn.entry.lastShareAt = new Date();
    } else {
      conn.entry.sharesRejected++;
    }

    const rentalId = conn.entry.rentalId;
    if (rentalId == null) return;

    let window = this.shareWindows.get(rentalId);
    if (!window) {
      window = {
        rentalId,
        rigId,
        startedAt: Date.now(),
        sharesAccepted: 0,
        sharesRejected: 0,
        difficultySum: 0,
        currentDifficulty: difficulty,
        lastShareAt: null,
        sharesAcceptedLifetime: 0,
        sharesRejectedLifetime: 0,
      };
      this.shareWindows.set(rentalId, window);
    }
    if (accepted) {
      window.sharesAccepted++;
      window.sharesAcceptedLifetime++;
      window.difficultySum += difficulty;
      window.lastShareAt = new Date();
    } else {
      window.sharesRejected++;
      window.sharesRejectedLifetime++;
    }
    window.currentDifficulty = difficulty;
  }

  setCurrentDifficulty(rentalId: number, difficulty: number): void {
    const window = this.shareWindows.get(rentalId);
    if (window) window.currentDifficulty = difficulty;
  }

  initShareWindow(rentalId: number, rigId: number): void {
    if (!this.shareWindows.has(rentalId)) {
      this.shareWindows.set(rentalId, {
        rentalId,
        rigId,
        startedAt: Date.now(),
        sharesAccepted: 0,
        sharesRejected: 0,
        difficultySum: 0,
        currentDifficulty: 1,
        lastShareAt: null,
        sharesAcceptedLifetime: 0,
        sharesRejectedLifetime: 0,
      });
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

  flushAndResetWindow(rentalId: number): ShareWindow | null {
    const window = this.shareWindows.get(rentalId);
    if (!window) return null;
    const snapshot = { ...window };
    // Reset only current-window counters; lifetime totals carry forward.
    this.shareWindows.set(rentalId, {
      ...window,
      startedAt: Date.now(),
      sharesAccepted: 0,
      sharesRejected: 0,
      difficultySum: 0,
    });
    return snapshot;
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
    if (!window) {
      return {
        minerConnected: false,
        upstreamConnected: false,
        poolAuthFailed: false,
        sharesAccepted: 0,
        sharesRejected: 0,
        lastShareAt: null,
        currentDifficulty: 1,
        effectiveHashrateH: 0,
      };
    }
    const elapsedSec = Math.max(1, (Date.now() - window.startedAt) / 1000);
    const effectiveHashrateH =
      (window.difficultySum * 4294967296) / elapsedSec;

    const conn = Array.from(this.rigConnections.values()).find(
      (c) => c.entry.rentalId === rentalId,
    );
    return {
      minerConnected: conn != null,
      upstreamConnected: conn?.entry.upstreamConnected ?? false,
      poolAuthFailed: conn?.entry.upstreamAuthFailed ?? false,
      // Return cumulative lifetime totals for stable rental-level accounting.
      sharesAccepted: window.sharesAcceptedLifetime,
      sharesRejected: window.sharesRejectedLifetime,
      lastShareAt: window.lastShareAt,
      currentDifficulty: window.currentDifficulty,
      effectiveHashrateH,
    };
  }

  getAllWindows(): ShareWindow[] {
    return Array.from(this.shareWindows.values());
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

    // Compute a true shares/sec rate from the active rolling share windows.
    const nowMs = Date.now();
    const currentSharesPerSec = Array.from(this.shareWindows.values()).reduce(
      (sum, w) => {
        const elapsedSec = Math.max(1, (nowMs - w.startedAt) / 1000);
        return sum + w.sharesAccepted / elapsedSec;
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

  getConnectedRigIds(): number[] {
    return Array.from(this.rigConnections.keys());
  }

  forceDisconnect(rigId: number): boolean {
    const conn = this.rigConnections.get(rigId);
    if (!conn) return false;
    conn.session.disconnect("Admin forced disconnect");
    return true;
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
   * Return the extranonce of any currently-parked upstream WITHOUT claiming it.
   * Called from _handleSubscribe so the miner gets the pool's extranonce
   * directly in the subscribe response — preventing the need to send
   * mining.set_extranonce mid-session (which triggers ASIC reconnects).
   * When there are multiple parked upstreams (multi-rig) we cannot reliably
   * pick the right one, so we return null and let the normal flow handle it.
   */
  getAnyParkedExtranonce(): { extranonce1: string; extranonce2Size: number } | null {
    if (this.parkedUpstreams.size !== 1) return null;
    const parked = Array.from(this.parkedUpstreams.values())[0];
    const e1 = parked.upstream.getExtranonce1();
    if (!e1) return null;
    return { extranonce1: e1, extranonce2Size: parked.upstream.getExtranonce2Size() };
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
}

export const proxyState = new ProxyState();
