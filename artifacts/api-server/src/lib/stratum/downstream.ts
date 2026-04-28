import * as net from "node:net";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { db, rigsTable, rentalsTable } from "@workspace/db";
import { logger } from "../logger";
import { proxyState } from "./state";
import { UpstreamClient } from "./upstream";
import type { JsonRpcMessage } from "./types";

const SUBMIT_BUFFER_MAX = 32; // Maximum buffered shares during upstream outage

function makeExtranonce1(): string {
  return randomBytes(4).toString("hex");
}

interface BufferedSubmit {
  msg: JsonRpcMessage;
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
  /** Buffered mining.submit messages received while upstream is unavailable. */
  private submitBuffer: BufferedSubmit[] = [];

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

  private async _handleAuthorize(msg: JsonRpcMessage): Promise<void> {
    const params = (msg.params ?? []) as string[];
    const workerStr = params[0] ?? "";
    const password = params[1] ?? "";

    const parts = workerStr.split(".");
    const rigIdStr = parts[0]?.replace(/^rig-/, "") ?? "";
    const rigId = parseInt(rigIdStr, 10);

    if (Number.isNaN(rigId)) {
      logger.warn({ workerStr }, "stratum:downstream bad worker format");
      this._reply(msg.id, false, [24, "Bad worker format, expected rig-{id}[.worker]"]);
      this._close();
      return;
    }

    const [rig] = await db
      .select({ id: rigsTable.id, name: rigsTable.name, proxyToken: rigsTable.proxyToken })
      .from(rigsTable)
      .where(eq(rigsTable.id, rigId));

    if (!rig) {
      logger.warn({ rigId }, "stratum:downstream rig not found");
      this._reply(msg.id, false, [24, "Rig not found"]);
      this._close();
      return;
    }

    if (!rig.proxyToken || password !== rig.proxyToken) {
      logger.warn({ rigId }, "stratum:downstream bad credentials");
      this._reply(msg.id, false, [24, "Bad credentials"]);
      this._close();
      return;
    }

    this.rigId = rig.id;
    this.authorized = true;
    proxyState.addRig(rig.id, this, rig.name);

    // Persist last-seen timestamp so admin can see when a rig was last active.
    await db
      .update(rigsTable)
      .set({ lastSeenAt: new Date() })
      .where(eq(rigsTable.id, rig.id));

    const activeRental = await this._findActiveRental(rig.id);
    this.rentalId = activeRental?.id ?? null;
    proxyState.setRigAuthorized(rig.id, this.rentalId);

    this._reply(msg.id, true);
    logger.info({ rigId: rig.id, rentalId: this.rentalId }, "stratum:downstream authorized");

    if (activeRental) {
      await this._startUpstream(activeRental);
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
    this.rentalId = rentalId;
    if (this.rigId != null) proxyState.setRigAuthorized(this.rigId, rentalId);
    await this._startUpstream({ id: rentalId, poolUrl, poolWorker, poolPassword, endsAt: new Date(Date.now() + 9999999) });
  }

  deactivateRental(): void {
    if (this.upstream) {
      this.upstream.destroy();
      this.upstream = null;
    }
    this.submitBuffer = [];
    this.rentalId = null;
    if (this.rigId != null) {
      proxyState.setRigAuthorized(this.rigId, null);
      proxyState.setUpstreamConnected(this.rigId, false);
    }
    this._notify("mining.set_difficulty", [1]);
    logger.info({ rigId: this.rigId }, "stratum:downstream rental deactivated, miner now idle");
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
      // Upstream is already connected — mark it and flush any buffered shares.
      if (this.rigId != null) proxyState.setUpstreamConnected(this.rigId, true);
      await this._flushSubmitBuffer();
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
      // Replay any shares that were buffered while upstream was unavailable.
      void this._flushSubmitBuffer();
    });

    upstream.on("disconnected", () => {
      if (this.rigId != null) proxyState.setUpstreamConnected(this.rigId, false);
    });
  }

  /** Replay buffered mining.submit messages now that upstream is available. */
  private async _flushSubmitBuffer(): Promise<void> {
    if (this.submitBuffer.length === 0) return;
    const buffered = this.submitBuffer.splice(0);
    logger.info(
      { rigId: this.rigId, count: buffered.length },
      "stratum:downstream replaying buffered shares",
    );
    for (const { msg } of buffered) {
      await this._handleSubmit(msg);
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
      // Buffer the share rather than immediately rejecting it.
      if (this.rentalId != null) {
        if (this.submitBuffer.length < SUBMIT_BUFFER_MAX) {
          this.submitBuffer.push({ msg });
          logger.debug(
            { rigId: this.rigId, bufferLen: this.submitBuffer.length },
            "stratum:downstream share buffered (upstream unavailable)",
          );
        } else {
          logger.warn({ rigId: this.rigId }, "stratum:downstream submit buffer full, share dropped");
        }
        // Respond accepted optimistically so the miner does not stall.
        this._reply(msg.id, true, null);
      } else {
        this._reply(msg.id, false, [21, "No active rental"]);
      }
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

    if (this.rigId != null) {
      proxyState.recordShare(this.rigId, accepted, diff);
    }

    logger.debug(
      { rigId: this.rigId, rentalId: this.rentalId, accepted, diff },
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
    }
    // Park the upstream for the reconnect grace period instead of destroying it
    // immediately. This keeps the pool connection alive for 60 s while the rig
    // reconnects after a brief network glitch.
    if (this.upstream != null && this.rentalId != null) {
      proxyState.parkUpstream(this.rentalId, this.upstream);
      this.upstream = null;
    } else if (this.upstream != null) {
      this.upstream.destroy();
      this.upstream = null;
    }
    logger.info({ rigId: this.rigId }, "stratum:downstream closed");
    this.emit("close");
  }
}
