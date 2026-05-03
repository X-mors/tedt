import * as net from "node:net";
import * as dns from "node:dns/promises";
import { EventEmitter } from "node:events";
import { logger } from "../logger";
import { isPrivateIp } from "../ssrf";
import type { JsonRpcMessage } from "./types";

const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000];

export class UpstreamClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private buffer = "";
  private msgIdCounter = 1;
  private pendingRequests = new Map<
    string,
    { resolve: (r: unknown) => void; reject: (e: Error) => void }
  >();
  private reconnectAttempt = 0;
  private destroyed = false;
  private subscriptionId: string | null = null;
  private extranonce1: string | null = null;
  private extranonce2Size = 4;
  private currentDifficulty = 1;
  /**
   * Difficulty active at the moment each job was issued by the pool. Used so
   * that share accounting credits the correct difficulty even if `mining.set_difficulty`
   * arrives between the job and the share submission. Capped to the most recent
   * JOB_DIFF_HISTORY_LIMIT jobs (FIFO eviction) to bound memory.
   */
  private jobDifficulty = new Map<string, number>();
  private static readonly JOB_DIFF_HISTORY_LIMIT = 256;
  private connectTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly poolUrl: string,
    private readonly poolWorker: string,
    private readonly poolPassword: string,
    private readonly rentalId: number,
    /** If set, send mining.configure with version-rolling before subscribing. */
    private readonly versionRollingMask?: string,
  ) {
    super();
  }

  connect(): void {
    // Kick off the async connect path without blocking the caller.
    void this._connectAsync();
  }

  private async _connectAsync(): Promise<void> {
    if (this.destroyed) return;
    this._clearConnectTimer();
    const parsed = this._parsePoolUrl(this.poolUrl);
    if (!parsed) {
      logger.error(
        { rentalId: this.rentalId, poolUrl: this.poolUrl },
        "stratum:upstream invalid pool URL",
      );
      this.emit("error", new Error(`Invalid pool URL: ${this.poolUrl}`));
      return;
    }
    const { host, port } = parsed;

    // Re-resolve the hostname on every connect attempt and validate the returned
    // IPs to defend against DNS rebinding after rental creation.
    // Resolve BOTH IPv4 and IPv6 addresses so we can fall back at the connect
    // layer — many VPS providers (e.g. Contabo) have working IPv6 routes to
    // pools like NiceHash but their IPv4 ranges are firewalled by the pool, so
    // an IPv4-only lookup succeeds yet the TCP connect times out.
    let candidates: string[] = [];
    try {
      const all = await dns.lookup(host, { all: true, family: 0 });
      const validated = all
        .map((r) => r.address)
        .filter((addr) => {
          if (isPrivateIp(addr)) {
            logger.warn(
              { rentalId: this.rentalId, host, address: addr },
              "stratum:upstream skipping private/reserved IP (DNS rebinding guard)",
            );
            return false;
          }
          return true;
        });
      // Prefer IPv4 first, then IPv6 — IPv4 is usually faster when reachable,
      // but we always try the other family if the first fails to connect.
      const v4 = validated.filter((a) => a.includes("."));
      const v6 = validated.filter((a) => !a.includes("."));
      candidates = [...v4, ...v6];
    } catch {
      // ignore — empty candidates handled below
    }
    if (candidates.length === 0) {
      logger.error(
        { rentalId: this.rentalId, host },
        "stratum:upstream hostname resolution failed — scheduling reconnect",
      );
      this.emit("error", new Error(`Pool hostname could not be resolved: ${host}`));
      if (!this.destroyed) this._scheduleReconnect();
      return;
    }

    // Try each candidate IP in order with a short per-attempt connect budget
    // so we fall through to the next family quickly when one is firewalled.
    const PER_ATTEMPT_MS = 5_000;
    let sock: net.Socket | null = null;
    let lastErr: Error | null = null;
    let resolvedHost = candidates[0]!;
    for (const addr of candidates) {
      if (this.destroyed) return;
      logger.info(
        { rentalId: this.rentalId, host, resolvedHost: addr, port },
        "stratum:upstream connecting",
      );
      const attempt = net.createConnection({ host: addr, port });
      const ok = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => {
          attempt.destroy();
          resolve(false);
        }, PER_ATTEMPT_MS);
        attempt.once("connect", () => {
          clearTimeout(t);
          resolve(true);
        });
        attempt.once("error", (e: Error) => {
          clearTimeout(t);
          lastErr = e;
          resolve(false);
        });
      });
      if (ok) {
        sock = attempt;
        resolvedHost = addr;
        break;
      }
      logger.warn(
        { rentalId: this.rentalId, host, tried: addr },
        "stratum:upstream connect attempt failed — trying next address",
      );
    }
    if (!sock) {
      this.emit(
        "error",
        new Error(
          `Could not connect to ${host}:${port} via any address (last: ${lastErr?.message ?? "timeout"})`,
        ),
      );
      if (!this.destroyed) this._scheduleReconnect();
      return;
    }
    this.socket = sock;
    sock.setEncoding("utf8");
    sock.setTimeout(120_000);
    // Connect already happened in the candidate-loop above, so kick off the
    // subscribe handshake directly instead of waiting for a "connect" event
    // that will never fire on this already-open socket.
    this.reconnectAttempt = 0;
    this._subscribe();

    sock.on("data", (chunk: string) => {
      this.buffer += chunk;
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed) as JsonRpcMessage;
          this._handleMessage(msg);
        } catch {
          logger.warn(
            { rentalId: this.rentalId, line: trimmed },
            "stratum:upstream bad JSON",
          );
        }
      }
    });

    sock.on("timeout", () => {
      logger.warn({ rentalId: this.rentalId }, "stratum:upstream timeout");
      sock.destroy();
    });

    sock.on("error", (err: Error) => {
      logger.warn({ err, rentalId: this.rentalId }, "stratum:upstream error");
    });

    sock.on("close", () => {
      logger.info({ rentalId: this.rentalId }, "stratum:upstream closed");
      this.socket = null;
      this.emit("disconnected");
      if (!this.destroyed) this._scheduleReconnect();
    });
  }

  private _parsePoolUrl(
    url: string,
  ): { host: string; port: number } | null {
    try {
      const stripped = url
        .replace(/^stratum\+tcp:\/\//i, "")
        .replace(/^stratum:\/\//i, "");
      const lastColon = stripped.lastIndexOf(":");
      if (lastColon === -1) return null;
      const host = stripped.slice(0, lastColon);
      const port = parseInt(stripped.slice(lastColon + 1), 10);
      if (!host || Number.isNaN(port)) return null;
      return { host, port };
    } catch {
      return null;
    }
  }

  private _send(msg: object): void {
    if (!this.socket || this.socket.destroyed) return;
    this.socket.write(JSON.stringify(msg) + "\n");
  }

  private _nextId(): string {
    return `up-${this.rentalId}-${this.msgIdCounter++}`;
  }

  private async _subscribe(): Promise<void> {
    try {
      // If the downstream miner negotiated version-rolling, inform the upstream
      // pool via mining.configure. We fire-and-forget (no await) because many
      // pools do not implement this extension and will never reply — waiting
      // for a response would stall the connection for 30 s before timing out.
      // The response (if any) is intentionally left unhandled; the important
      // thing is that the pool receives the hint so it can include version bits
      // in its job notifications.
      if (this.versionRollingMask) {
        const cfgId = this._nextId();
        this._send({
          id: cfgId,
          method: "mining.configure",
          params: [
            ["version-rolling"],
            { "version-rolling.mask": this.versionRollingMask, "version-rolling.min-bit-count": 2 },
          ],
        });
        logger.debug(
          { rentalId: this.rentalId, mask: this.versionRollingMask },
          "stratum:upstream sent mining.configure (version-rolling) to pool (fire-and-forget)",
        );
      }

      const subId = this._nextId();
      const subResult = await this._request(subId, "mining.subscribe", [
        "rigmarket-proxy/1.0",
        null,
      ]);

      const result = subResult as unknown[];
      if (Array.isArray(result) && result.length >= 3) {
        const subs = result[0] as unknown[];
        this.subscriptionId = Array.isArray(subs) && subs.length > 0
          ? String((subs[0] as unknown[])[1] ?? "")
          : "";
        this.extranonce1 = String(result[1]);
        this.extranonce2Size = Number(result[2]) || 4;
      }

      this.emit("subscribed", {
        extranonce1: this.extranonce1,
        extranonce2Size: this.extranonce2Size,
      });

      const authId = this._nextId();
      const authOk = await this._request(authId, "mining.authorize", [
        this.poolWorker,
        this.poolPassword,
      ]);

      if (!authOk) {
        logger.error(
          { rentalId: this.rentalId, worker: this.poolWorker },
          "stratum:upstream pool auth failed",
        );
        this.emit("authFailed");
        return;
      }

      logger.info(
        { rentalId: this.rentalId, worker: this.poolWorker },
        "stratum:upstream pool auth OK",
      );
      this.emit("ready");
    } catch (err) {
      logger.error(
        { err, rentalId: this.rentalId },
        "stratum:upstream subscribe/auth error",
      );
    }
  }

  private _request(
    id: string,
    method: string,
    params: unknown[],
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this._send({ id, method, params });
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request ${method} timed out`));
        }
      }, 30_000);
    });
  }

  private _handleMessage(msg: JsonRpcMessage): void {
    if (msg.id != null) {
      const key = String(msg.id);
      const pending = this.pendingRequests.get(key);
      if (pending) {
        this.pendingRequests.delete(key);
        if (msg.error) {
          pending.reject(new Error(JSON.stringify(msg.error)));
        } else {
          pending.resolve(msg.result);
        }
        return;
      }
    }

    if (!msg.method) return;

    switch (msg.method) {
      case "mining.set_difficulty":
        this.currentDifficulty = Number(
          (msg.params as unknown[])?.[0] ?? 1,
        );
        this.emit("setDifficulty", this.currentDifficulty);
        break;

      case "mining.notify": {
        const params = msg.params as unknown[] | undefined;
        const jobId = params && params.length > 0 ? String(params[0] ?? "") : "";
        if (jobId) {
          this.jobDifficulty.set(jobId, this.currentDifficulty);
          if (this.jobDifficulty.size > UpstreamClient.JOB_DIFF_HISTORY_LIMIT) {
            const firstKey = this.jobDifficulty.keys().next().value;
            if (firstKey !== undefined) this.jobDifficulty.delete(firstKey);
          }
        }
        this.emit("notify", msg.params);
        break;
      }

      case "mining.set_extranonce":
        this.extranonce1 = String((msg.params as unknown[])?.[0] ?? "");
        this.extranonce2Size =
          Number((msg.params as unknown[])?.[1]) || this.extranonce2Size;
        this.emit("setExtranonce", {
          extranonce1: this.extranonce1,
          extranonce2Size: this.extranonce2Size,
        });
        break;

      case "client.reconnect":
        logger.info({ rentalId: this.rentalId }, "stratum:upstream pool requested reconnect");
        this.socket?.destroy();
        break;
    }
  }

  submitShare(
    jobId: string,
    extranonce2: string,
    ntime: string,
    nonce: string,
    versionBits?: string,
  ): Promise<boolean> {
    const id = this._nextId();
    // Standard Stratum submit params: [worker, jobId, extranonce2, ntime, nonce]
    // ASICBoost version-rolling appends versionBits as a 6th parameter.
    const submitParams: string[] = [this.poolWorker, jobId, extranonce2, ntime, nonce];
    if (versionBits) submitParams.push(versionBits);
    return this._request(id, "mining.submit", submitParams).then((result) => {
      return result === true;
    }).catch(() => false);
  }

  getCurrentDifficulty(): number {
    return this.currentDifficulty;
  }

  /**
   * Forward the miner's preferred starting difficulty to the upstream pool
   * via mining.suggest_difficulty (Stratum extension). Fire-and-forget — the
   * pool may ignore or honour the hint. Has no effect when not yet connected.
   */
  suggestDifficulty(diff: number): void {
    if (!this.socket || this.socket.destroyed) return;
    this._send({
      id: this._nextId(),
      method: "mining.suggest_difficulty",
      params: [diff],
    });
  }

  /**
   * Return the difficulty that was active when the given job was issued.
   * Falls back to the current difficulty if the job is unknown (e.g. evicted
   * from the bounded history, or the share refers to a job from a previous
   * upstream connection).
   */
  getJobDifficulty(jobId: string): number {
    return this.jobDifficulty.get(jobId) ?? this.currentDifficulty;
  }

  private _scheduleReconnect(): void {
    if (this.destroyed) return;
    const delay =
      RECONNECT_DELAYS[
        Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)
      ];
    this.reconnectAttempt++;
    logger.info(
      { rentalId: this.rentalId, delay, attempt: this.reconnectAttempt },
      "stratum:upstream scheduling reconnect",
    );
    this.connectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  private _clearConnectTimer(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  destroy(): void {
    this.destroyed = true;
    this._clearConnectTimer();
    this.pendingRequests.forEach(({ reject }) =>
      reject(new Error("Upstream destroyed")),
    );
    this.pendingRequests.clear();
    this.socket?.destroy();
    this.socket = null;
  }
}
