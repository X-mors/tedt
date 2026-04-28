import * as net from "node:net";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { db, rigsTable, rentalsTable, proxyAuthFailuresTable } from "@workspace/db";
import { logger } from "../logger";
import { proxyState } from "./state";
import { UpstreamClient } from "./upstream";
import type { JsonRpcMessage } from "./types";


/** Maximum number of shares buffered while upstream is temporarily unavailable. */
const SUBMIT_BUFFER_MAX = 64;

/**
 * Stores share parameters for replay after upstream reconnects.
 * We do NOT store the original request ID so there is no risk of sending a
 * duplicate reply to the miner — the miner already received `result: true`.
 */
interface BufferedSubmit {
  jobId: string;
  extranonce2: string;
  ntime: string;
  nonce: string;
  diff: number;
}

function makeExtranonce1(): string {
  return randomBytes(4).toString("hex");
}

export class DownstreamSession extends EventEmitter {
  private buffer = "";
  private msgIdCounter = 1;
  private destroyed = false;
  private rigId: number | null = null;
  private rentalId: number | null = null;
  private upstream: UpstreamClient | null = null;
  private extranonce1 = "";
  private extranonce2Size = 4;
  private subscribed = false;
  private authorized = false;
  private currentDifficulty = 1;
  private lastJobId: string | null = null;
  /**
   * True when `this.upstream` is connected to the rig owner's fallback pool
   * (not a renter's pool). Shares submitted in this mode are forwarded to the
   * owner's pool but are NOT tracked in rental accounting.
   */
  private isFallback = false;
  /**
   * Bounded buffer of share parameters received while upstream is unavailable.
   * The miner receives `result: true` immediately; actual pool result is applied
   * when upstream reconnects (no duplicate reply to miner).
   */
  private submitBuffer: BufferedSubmit[] = [];
  /** Tracks the last time we wrote lastSeenAt to DB to avoid per-share writes. */
  private lastSeenAtWrittenMs = 0;

  constructor(private readonly socket: net.Socket) {
    super();
    socket.setEncoding("utf8");
    socket.setTimeout(300_000);

    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          this._handleMessage(JSON.parse(trimmed) as JsonRpcMessage);
        } catch {
          logger.warn(
            { rigId: this.rigId, line: trimmed },
            "stratum:downstream bad JSON",
          );
        }
      }
    });

    socket.on("timeout", () => {
      logger.info({ rigId: this.rigId }, "stratum:downstream timeout");
      this._close();
    });

    socket.on("error", (err: Error) => {
      logger.warn({ err, rigId: this.rigId }, "stratum:downstream error");
    });

    socket.on("close", () => {
      this._onClose();
    });
  }

  private _send(msg: object): void {
    if (!this.socket.destroyed) {
      this.socket.write(JSON.stringify(msg) + "\n");
    }
  }

  private _reply(id: number | string | null, result: unknown, error: unknown = null): void {
    this._send({ id, result, error });
  }

  private _notify(method: string, params: unknown[]): void {
    this._send({ id: null, method, params });
  }

  private async _handleMessage(msg: JsonRpcMessage): Promise<void> {
    if (!msg.method) return;

    switch (msg.method) {
      case "mining.subscribe":
        await this._handleSubscribe(msg);
        break;
      case "mining.authorize":
        await this._handleAuthorize(msg);
        break;
      case "mining.submit":
        await this._handleSubmit(msg);
        break;
      case "mining.suggest_difficulty":
        break;
      case "mining.extranonce.subscribe":
        this._reply(msg.id, true);
        break;
      default:
        logger.debug(
          { rigId: this.rigId, method: msg.method },
          "stratum:downstream unknown method",
        );
    }
  }

  private async _handleSubscribe(msg: JsonRpcMessage): Promise<void> {
    if (this.subscribed) {
      this._reply(msg.id, null, [20, "Already subscribed"]);
      return;
    }
    this.subscribed = true;
    this.extranonce1 = makeExtranonce1();
    this.extranonce2Size = 4;

    this._reply(msg.id, [
      [["mining.set_difficulty", `sub-diff-${this.msgIdCounter}`]],
      this.extranonce1,
      this.extranonce2Size,
    ]);
    this._notify("mining.set_difficulty", [this.currentDifficulty]);
  }

  /**
   * Durably record an authentication failure in the database.
   * Non-blocking — errors are silently swallowed so a DB issue never breaks the
   * TCP-layer error path.
   */
  private _recordAuthFailure(rigId: number | null, reason: string): void {
    const remoteIp = this.socket.remoteAddress ?? "unknown";
    void db
      .insert(proxyAuthFailuresTable)
      .values({ rigId, remoteIp, failureReason: reason })
      .catch((err: unknown) => {
        logger.warn({ err }, "stratum:downstream failed to persist auth failure audit record");
      });
  }

  private async _handleAuthorize(msg: JsonRpcMessage): Promise<void> {
    const params = (msg.params ?? []) as string[];
    const workerStr = params[0] ?? "";
    const password = params[1] ?? "";

    const parts = workerStr.split(".");
    const rigIdStr = parts[0]?.replace(/^rig-/, "") ?? "";
    const rigId = parseInt(rigIdStr, 10);

    if (Number.isNaN(rigId)) {
      logger.warn({ workerStr }, "stratum:downstream bad worker format");
      this._recordAuthFailure(null, `Bad worker format: ${workerStr}`);
      this._reply(msg.id, false, [24, "Bad worker format, expected rig-{id}[.worker]"]);
      this._close();
      return;
    }

    const [rig] = await db
      .select({
        id: rigsTable.id,
        name: rigsTable.name,
        proxyToken: rigsTable.proxyToken,
        stratumHost: rigsTable.stratumHost,
        stratumPort: rigsTable.stratumPort,
        stratumUser: rigsTable.stratumUser,
        stratumPassword: rigsTable.stratumPassword,
      })
      .from(rigsTable)
      .where(eq(rigsTable.id, rigId));

    if (!rig) {
      logger.warn({ rigId }, "stratum:downstream rig not found");
      this._recordAuthFailure(rigId, "Rig not found");
      this._reply(msg.id, false, [24, "Rig not found"]);
      this._close();
      return;
    }

    if (!rig.proxyToken || password !== rig.proxyToken) {
      logger.warn({ rigId }, "stratum:downstream bad credentials");
      this._recordAuthFailure(rigId, "Bad credentials — token mismatch");
      this._reply(msg.id, false, [24, "Bad credentials"]);
      this._close();
      return;
    }

    this.rigId = rig.id;
    this.authorized = true;
    proxyState.addRig(rig.id, this, rig.name);

    // Persist online state and last-seen timestamp so admin can track connectivity.
    await db
      .update(rigsTable)
      .set({ isOnline: true, lastSeenAt: new Date() })
      .where(eq(rigsTable.id, rig.id));

    const activeRental = await this._findActiveRental(rig.id);
    this.rentalId = activeRental?.id ?? null;
    proxyState.setRigAuthorized(rig.id, this.rentalId);

    this._reply(msg.id, true);
    logger.info({ rigId: rig.id, rentalId: this.rentalId }, "stratum:downstream authorized");

    if (activeRental) {
      this.isFallback = false;
      await this._startUpstream(activeRental);
    } else if (rig.stratumHost && rig.stratumPort > 0) {
      await this._startFallbackUpstream(rig);
    } else {
      this._notify("mining.set_difficulty", [1]);
      logger.info({ rigId: rig.id }, "stratum:downstream no active rental, miner idle");
    }
  }

  private async _findActiveRental(rigId: number) {
    const now = new Date();
    const [rental] = await db
      .select({
        id: rentalsTable.id,
        poolUrl: rentalsTable.poolUrl,
        poolWorker: rentalsTable.poolWorker,
        poolPassword: rentalsTable.poolPassword,
        endsAt: rentalsTable.endsAt,
      })
      .from(rentalsTable)
      .where(
        and(
          eq(rentalsTable.rigId, rigId),
          eq(rentalsTable.status, "active"),
        ),
      );
    if (!rental || rental.endsAt < now) return null;
    return rental;
  }

  async activateRental(rentalId: number, poolUrl: string, poolWorker: string, poolPassword: string): Promise<void> {
    if (this.upstream) {
      this.upstream.destroy();
      this.upstream = null;
    }
    this.isFallback = false;
    this.rentalId = rentalId;
    if (this.rigId != null) proxyState.setRigAuthorized(this.rigId, rentalId);
    await this._startUpstream({ id: rentalId, poolUrl, poolWorker, poolPassword, endsAt: new Date(Date.now() + 9999999) });
  }

  deactivateRental(): void {
    const prevRentalId = this.rentalId;
    if (this.upstream) {
      this.upstream.destroy();
      this.upstream = null;
    }
    this.submitBuffer = [];
    this.rentalId = null;
    this.isFallback = false;
    if (this.rigId != null) {
      proxyState.setRigAuthorized(this.rigId, null);
      proxyState.setUpstreamConnected(this.rigId, false);
    }
    // Remove the share window so the flush loop stops inserting samples for
    // this finished rental.
    if (prevRentalId != null) {
      proxyState.removeShareWindow(prevRentalId);
    }
    this._notify("mining.set_difficulty", [1]);
    logger.info({ rigId: this.rigId }, "stratum:downstream rental deactivated, reconnecting to fallback pool if configured");

    // After rental ends, reconnect to owner's fallback pool if configured.
    if (this.rigId != null) {
      void this._connectFallbackIfConfigured(this.rigId);
    }
  }

  /**
   * Look up the rig's fallback pool settings from DB and connect to them.
   * Called after auth (no rental) and after a rental ends.
   */
  private async _connectFallbackIfConfigured(rigId: number): Promise<void> {
    const [rig] = await db
      .select({
        id: rigsTable.id,
        stratumHost: rigsTable.stratumHost,
        stratumPort: rigsTable.stratumPort,
        stratumUser: rigsTable.stratumUser,
        stratumPassword: rigsTable.stratumPassword,
      })
      .from(rigsTable)
      .where(eq(rigsTable.id, rigId));

    // Guard: if a rental has started while we were awaiting the DB read, do not
    // overwrite the active rental upstream with a fallback connection.
    if (rig?.stratumHost && rig.stratumPort > 0 && this.rentalId === null) {
      await this._startFallbackUpstream(rig);
    }
  }

  /**
   * Start an upstream connection to the rig owner's own pool (fallback mode).
   * Shares forwarded in this mode are NOT counted toward any rental accounting.
   */
  private async _startFallbackUpstream(rig: {
    id: number;
    stratumHost: string;
    stratumPort: number;
    stratumUser: string;
    stratumPassword: string;
  }): Promise<void> {
    this.isFallback = true;
    const poolUrl = `stratum+tcp://${rig.stratumHost}:${rig.stratumPort}`;
    const worker = rig.stratumUser || `rig-${rig.id}`;
    const password = rig.stratumPassword || "x";

    // Use 0 as a sentinel rentalId for fallback connections (no real rental).
    const upstream = new UpstreamClient(poolUrl, worker, password, 0);
    this.upstream = upstream;
    this._wireFallbackUpstreamEvents(rig.id);
    upstream.connect();

    logger.info(
      { rigId: rig.id, poolUrl, worker },
      "stratum:downstream connecting to owner fallback pool",
    );
  }

  /** Wire upstream events for a fallback pool connection (no rental accounting). */
  private _wireFallbackUpstreamEvents(rigId: number): void {
    const upstream = this.upstream;
    if (!upstream) return;

    upstream.on("setDifficulty", (diff: number) => {
      this.currentDifficulty = diff;
      this._notify("mining.set_difficulty", [diff]);
    });

    upstream.on("notify", (params: unknown) => {
      this.lastJobId = Array.isArray(params) ? String(params[0]) : null;
      this._notify("mining.notify", params as unknown[]);
    });

    upstream.on("subscribed", ({ extranonce1, extranonce2Size }: { extranonce1: string; extranonce2Size: number }) => {
      this.extranonce1 = extranonce1 ?? this.extranonce1;
      this.extranonce2Size = extranonce2Size;
      this._notify("mining.set_extranonce", [this.extranonce1, this.extranonce2Size]);
    });

    upstream.on("setExtranonce", ({ extranonce1, extranonce2Size }: { extranonce1: string; extranonce2Size: number }) => {
      this.extranonce1 = extranonce1;
      this.extranonce2Size = extranonce2Size;
      this._notify("mining.set_extranonce", [extranonce1, extranonce2Size]);
    });

    upstream.on("ready", () => {
      proxyState.setUpstreamConnected(rigId, true);
      void this._flushSubmitBuffer();
      logger.info({ rigId }, "stratum:downstream fallback upstream ready");
    });

    upstream.on("disconnected", () => {
      proxyState.setUpstreamConnected(rigId, false);
      proxyState.incrementUpstreamDisconnect(rigId);
    });

    upstream.on("error", () => {
      proxyState.incrementUpstreamError(rigId);
    });
  }

  private async _startUpstream(rental: {
    id: number;
    poolUrl: string;
    poolWorker: string;
    poolPassword: string;
    endsAt: Date;
  }): Promise<void> {
    if (this.rigId == null) return;
    proxyState.initShareWindow(rental.id, this.rigId);

    // Attempt to reuse a parked upstream from a recent reconnect grace window.
    const parked = proxyState.claimParkedUpstream(rental.id);
    if (parked) {
      logger.info(
        { rigId: this.rigId, rentalId: rental.id },
        "stratum:downstream reusing parked upstream (reconnect grace)",
      );
      this.upstream = parked;
      this._wireUpstreamEvents(rental.id);
      // Upstream is already connected — mark ready and drain any buffered shares.
      if (this.rigId != null) proxyState.setUpstreamConnected(this.rigId, true);
      void this._flushSubmitBuffer();
      return;
    }

    const upstream = new UpstreamClient(
      rental.poolUrl,
      rental.poolWorker,
      rental.poolPassword,
      rental.id,
    );
    this.upstream = upstream;
    this._wireUpstreamEvents(rental.id);
    upstream.connect();
  }

  private _wireUpstreamEvents(rentalId: number): void {
    const upstream = this.upstream;
    if (!upstream) return;

    upstream.on("setDifficulty", (diff: number) => {
      this.currentDifficulty = diff;
      if (this.rigId != null) {
        proxyState.setCurrentDifficulty(rentalId, diff);
      }
      this._notify("mining.set_difficulty", [diff]);
    });

    upstream.on("notify", (params: unknown) => {
      this.lastJobId = Array.isArray(params) ? String(params[0]) : null;
      this._notify("mining.notify", params as unknown[]);
    });

    upstream.on("subscribed", ({ extranonce1, extranonce2Size }: { extranonce1: string; extranonce2Size: number }) => {
      this.extranonce1 = extranonce1 ?? this.extranonce1;
      this.extranonce2Size = extranonce2Size;
      this._notify("mining.set_extranonce", [this.extranonce1, this.extranonce2Size]);
    });

    upstream.on("setExtranonce", ({ extranonce1, extranonce2Size }: { extranonce1: string; extranonce2Size: number }) => {
      this.extranonce1 = extranonce1;
      this.extranonce2Size = extranonce2Size;
      this._notify("mining.set_extranonce", [extranonce1, extranonce2Size]);
    });

    upstream.on("ready", () => {
      if (this.rigId != null) proxyState.setUpstreamConnected(this.rigId, true);
      logger.info({ rigId: this.rigId, rentalId }, "stratum:downstream upstream ready");
      void this._flushSubmitBuffer();
    });

    upstream.on("disconnected", () => {
      if (this.rigId != null) {
        proxyState.setUpstreamConnected(this.rigId, false);
        proxyState.incrementUpstreamDisconnect(this.rigId);
      }
    });

    upstream.on("error", () => {
      if (this.rigId != null) proxyState.incrementUpstreamError(this.rigId);
    });
  }

  /**
   * Replay buffered mining.submit messages now that upstream is available.
   * Critically, NO miner reply is sent here — the miner already received an
   * optimistic `result: true` when the share was buffered. We only use the
   * pool's actual response to update share accounting (accepted/rejected).
   */
  private async _flushSubmitBuffer(): Promise<void> {
    if (this.submitBuffer.length === 0) return;
    const buffered = this.submitBuffer.splice(0);
    logger.info(
      { rigId: this.rigId, count: buffered.length },
      "stratum:downstream replaying buffered shares",
    );
    for (const { jobId, extranonce2, ntime, nonce, diff } of buffered) {
      if (!this.upstream) break; // Upstream went away again
      let accepted = false;
      try {
        accepted = await this.upstream.submitShare(jobId, extranonce2, ntime, nonce);
      } catch {
        accepted = false;
      }
      // Only track rental shares in accounting; fallback shares go to the owner's
      // pool but are not counted toward any rental window.
      if (this.rigId != null && !this.isFallback) {
        proxyState.recordShare(this.rigId, accepted, diff);
      }
    }
  }

  private async _handleSubmit(msg: JsonRpcMessage): Promise<void> {
    if (!this.authorized) {
      this._reply(msg.id, false, [24, "Not authorized"]);
      return;
    }

    const params = (msg.params ?? []) as string[];
    const jobId = params[1] ?? "";
    const extranonce2 = params[2] ?? "";
    const ntime = params[3] ?? "";
    const nonce = params[4] ?? "";

    if (!this.upstream) {
      // Return error only when there is no rental AND no fallback configured.
      if (this.rentalId == null && !this.isFallback) {
        this._reply(msg.id, false, [21, "No active rental"]);
        return;
      }
      // Upstream temporarily unavailable — buffer the share for replay.
      if (this.submitBuffer.length < SUBMIT_BUFFER_MAX) {
        this.submitBuffer.push({ jobId, extranonce2, ntime, nonce, diff: this.currentDifficulty });
        logger.debug(
          { rigId: this.rigId, bufferLen: this.submitBuffer.length },
          "stratum:downstream share buffered (upstream unavailable)",
        );
      } else {
        if (this.rigId != null) proxyState.incrementDropped(this.rigId);
        logger.warn({ rigId: this.rigId }, "stratum:downstream submit buffer full, share dropped");
      }
      // Optimistic accept keeps the miner connected and hashing.
      this._reply(msg.id, true, null);
      return;
    }

    const diff = this.upstream.getCurrentDifficulty() || this.currentDifficulty;
    let accepted = false;
    try {
      accepted = await this.upstream.submitShare(
        jobId,
        extranonce2,
        ntime,
        nonce,
      );
    } catch {
      accepted = false;
    }

    this._reply(msg.id, accepted, accepted ? null : [23, "Low difficulty share"]);

    // Only track shares in rental accounting; fallback shares are excluded.
    if (this.rigId != null && !this.isFallback) {
      proxyState.recordShare(this.rigId, accepted, diff);
      // Refresh lastSeenAt heartbeat at most once per minute to avoid DB hotspot.
      const nowMs = Date.now();
      if (nowMs - this.lastSeenAtWrittenMs > 60_000) {
        this.lastSeenAtWrittenMs = nowMs;
        void db
          .update(rigsTable)
          .set({ lastSeenAt: new Date(nowMs) })
          .where(eq(rigsTable.id, this.rigId));
      }
    } else if (this.rigId != null && this.isFallback) {
      // Still update lastSeenAt for fallback connections (owner's rig is online).
      const nowMs = Date.now();
      if (nowMs - this.lastSeenAtWrittenMs > 60_000) {
        this.lastSeenAtWrittenMs = nowMs;
        void db
          .update(rigsTable)
          .set({ lastSeenAt: new Date(nowMs) })
          .where(eq(rigsTable.id, this.rigId));
      }
    }

    logger.debug(
      { rigId: this.rigId, rentalId: this.rentalId, isFallback: this.isFallback, accepted, diff },
      "stratum:downstream share",
    );
  }

  disconnect(reason: string): void {
    logger.info({ rigId: this.rigId, reason }, "stratum:downstream disconnect");
    this._close();
  }

  private _close(): void {
    if (!this.socket.destroyed) this.socket.destroy();
  }

  private _onClose(): void {
    if (this.rigId != null) {
      proxyState.removeRig(this.rigId);
      // Mark rig offline in DB (best-effort — do not await to avoid blocking).
      void db
        .update(rigsTable)
        .set({ isOnline: false })
        .where(eq(rigsTable.id, this.rigId));
    }
    if (this.upstream != null) {
      if (this.rentalId != null && !this.isFallback) {
        // Park rental upstream for the reconnect grace period — keeps the pool
        // connection alive for 60 s while the rig reconnects after a brief glitch.
        proxyState.parkUpstream(this.rentalId, this.upstream);
      } else {
        // Fallback upstreams are not parked — the owner's pool is cheap to
        // reconnect and parking by rentalId=0 would cause collisions.
        this.upstream.destroy();
      }
      this.upstream = null;
    }
    logger.info({ rigId: this.rigId }, "stratum:downstream closed");
    this.emit("close");
  }
}
