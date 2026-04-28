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

  addRig(rigId: number, session: DownstreamSession, rigName: string): void {
    this.rigConnections.set(rigId, {
      session,
      entry: {
        rigId,
        rigName,
        connectedAt: new Date(),
        authorized: false,
        rentalId: null,
        sharesAccepted: 0,
        sharesRejected: 0,
        lastShareAt: null,
        upstreamConnected: false,
      },
    });
  }

  removeRig(rigId: number): void {
    this.rigConnections.delete(rigId);
  }

  getRigSession(rigId: number): DownstreamSession | undefined {
    return this.rigConnections.get(rigId)?.session;
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
    if (conn) conn.entry.upstreamConnected = connected;
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

    const totalShares = entries.reduce(
      (sum, e) => sum + e.sharesAccepted + e.sharesRejected,
      0,
    );

    return {
      connectedRigs: entries,
      activeRoutes,
      totalSharesPerSec: totalShares,
    };
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
