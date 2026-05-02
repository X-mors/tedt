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

  /** The extranonce1 assigned by the upstream pool during subscription. */
  getExtranonce1(): string | null { return this.extranonce1; }
  /** The extranonce2 size assigned by the upstream pool during subscription. */
  getExtranonce2Size(): number { return this.extranonce2Size; }
  private currentDifficulty = 1;
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
    let resolvedHost: string = host;
    try {
      const { address } = await dns.lookup(host, { family: 4 }).catch(
        () => dns.lookup(host, { family: 6 }),
      );
      if (isPrivateIp(address)) {
        logger.error(
          { rentalId: this.rentalId, host, address },
          "stratum:upstream resolved IP is private/reserved — connection blocked (DNS rebinding guard)",
        );
        this.emit("error", new Error(`Pool hostname resolved to private IP: ${address}`));
        return;
      }
      resolvedHost = address;
    } catch {
      logger.error(
        { rentalId: this.rentalId, host },
        "stratum:upstream hostname resolution failed — scheduling reconnect",
      );
      this.emit("error", new Error(`Pool hostname could not be resolved: ${host}`));
      // Treat transient DNS failures as temporary; schedule a reconnect so the
      // upstream recovers automatically once DNS is available again.
      if (!this.destroyed) this._scheduleReconnect();
      return;
    }

    logger.info(
      { rentalId: this.rentalId, host, resolvedHost, port },
      "stratum:upstream connecting",
    );
    const sock = net.createConnection({ host: resolvedHost, port });
    this.socket = sock;
    sock.setEncoding("utf8");
    sock.setTimeout(120_000);

    sock.on("connect", () => {
      this.reconnectAttempt = 0;
      this._subscribe();
    });

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

      case "mining.notify":
        this.emit("notify", msg.params);
        break;

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
