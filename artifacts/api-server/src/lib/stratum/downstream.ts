import * as net from "node:net";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { eq, and, asc } from "drizzle-orm";
import { db, rigsTable, rentalsTable, proxyAuthFailuresTable, usersTable, algorithmsTable } from "@workspace/db";
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
  versionBits: string | undefined;
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
  /** Database ownerId — set after auth, used as fallback key when rigId mismatches. */
  private ownerId: number | null = null;
  private rentalId: number | null = null;
  private upstream: UpstreamClient | null = null;
  private extranonce1 = "";
  private extranonce2Size = 4;
  private subscribed = false;
  private authorized = false;
  private currentDifficulty = 1;
  private lastJobId: string | null = null;
  /** Version-rolling mask negotiated with the miner via mining.configure, or null if not negotiated. */
  private versionRollingMask: string | null = null;
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
  /** Timestamp of last data received FROM the miner (read side). */
  private lastReceivedMs = Date.now();

  constructor(private readonly socket: net.Socket) {
    super();
    socket.setEncoding("utf8");
    socket.setTimeout(300_000);
    // Detect dead connections (e.g. power cut) via OS-level keepalive probes.
    // After 60 s of inactivity the OS sends probes; if no ACK the socket errors.
    socket.setKeepAlive(true, 60_000);

    // Detect dead connections (e.g. power cut): if the miner sends no data for
    // 5 minutes we consider it gone. Miners submit shares regularly; even slow
    // rigs typically produce at least one share every few minutes.
    const INACTIVITY_MS = 5 * 60_000; // 5 minutes
    const _inactivityCheck = setInterval(() => {
      if (socket.destroyed) { clearInterval(_inactivityCheck); return; }
      if (Date.now() - this.lastReceivedMs > INACTIVITY_MS) {
        logger.info({ rigId: this.rigId }, "stratum:downstream miner inactivity timeout — closing dead connection");
        clearInterval(_inactivityCheck);
        this._close();
      }
    }, 60_000);
    socket.once("close", () => clearInterval(_inactivityCheck));

    socket.on("data", (chunk: string) => {
      this.lastReceivedMs = Date.now();
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
      case "mining.configure":
        this._handleConfigure(msg);
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

  /**
   * Handle mining.configure (BIP310 / Stratum extensions).
   * ASICBoost miners send this before subscribe to negotiate version-rolling.
   * We acknowledge each extension — version-rolling is passed through to the
   * upstream pool once the miner authenticates; until then we respond with
   * a zeroed mask so the miner can still connect without ASICBoost.
   */
  private _handleConfigure(msg: JsonRpcMessage): void {
    const extensions = (Array.isArray(msg.params?.[0]) ? msg.params[0] : []) as string[];
    const result: Record<string, unknown> = {};
    for (const ext of extensions) {
      if (ext === "version-rolling") {
        this.versionRollingMask = "1fffe000";
        result["version-rolling"] = true;
        result["version-rolling.mask"] = this.versionRollingMask;
        result["version-rolling.min-bit-count"] = 2;
      } else if (ext === "minimum-difficulty") {
        result["minimum-difficulty"] = true;
      } else if (ext === "subscribe-extranonce") {
        result["subscribe-extranonce"] = true;
      } else {
        result[ext] = false;
      }
    }
    logger.debug({ rigId: this.rigId, extensions }, "stratum:downstream mining.configure");
    this._reply(msg.id, result);
  }

  private async _handleSubscribe(msg: JsonRpcMessage): Promise<void> {
    if (this.subscribed) {
      this._reply(msg.id, null, [20, "Already subscribed"]);
      return;
    }
    this.subscribed = true;

    // If a parked upstream is waiting (miner reconnected after set_extranonce),
    // use the pool's extranonce directly so we never need to send set_extranonce
    // mid-session.  Many ASIC firmwares (Antminer M30+, Whatsminer, …) react to
    // set_extranonce by reconnecting — causing an infinite reconnect loop.
    // By seeding the subscribe response with the pool's extranonce we break the
    // loop: on the second connect the miner already has the correct extranonce
    // and the parked upstream is reused without any extranonce change.
    const parkedE = proxyState.getAnyParkedExtranonce();
    if (parkedE) {
      this.extranonce1 = parkedE.extranonce1;
      this.extranonce2Size = parkedE.extranonce2Size;
      logger.debug(
        { extranonce1: this.extranonce1 },
        "stratum:downstream subscribe — seeded with parked upstream extranonce",
      );
    } else {
      this.extranonce1 = makeExtranonce1();
      this.extranonce2Size = 4;
    }

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

    // -----------------------------------------------------------------------
    // Determine auth mode:
    //   Legacy: "rig-{number}" or "rig-{number}.suffix"  → authenticate by proxyToken
    //   New:    "{stratumUsername}.{rigname}"              → authenticate by stratumToken
    // -----------------------------------------------------------------------
    const firstDotIdx = workerStr.indexOf(".");
    const firstSegment = firstDotIdx >= 0 ? workerStr.slice(0, firstDotIdx) : workerStr;
    const isLegacy = /^rig-\d+$/.test(firstSegment);

    if (isLegacy) {
      await this._authorizeByProxyToken(msg, workerStr, password);
    } else if (firstDotIdx >= 0) {
      await this._authorizeByStratumToken(msg, workerStr, password, firstDotIdx);
    } else {
      // No dot and not legacy format — reject.
      logger.warn({ workerStr }, "stratum:downstream bad worker format (no dot separator)");
      this._recordAuthFailure(null, `Bad worker format: ${workerStr}`);
      this._reply(msg.id, false, [24, "Bad worker format. Use {username}.{rigname} or rig-{id}"]);
      this._close();
    }
  }

  /** Legacy auth: worker = "rig-{id}[.anything]", password = proxyToken */
  private async _authorizeByProxyToken(msg: JsonRpcMessage, workerStr: string, password: string): Promise<void> {
    const rigIdStr = workerStr.split(".")[0]?.replace(/^rig-/, "") ?? "";
    const rigId = parseInt(rigIdStr, 10);

    const [rig] = await db
      .select({
        id: rigsTable.id,
        ownerId: rigsTable.ownerId,
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
      logger.warn({ rigId }, "stratum:downstream legacy auth: rig not found");
      this._recordAuthFailure(rigId, "Rig not found");
      this._reply(msg.id, false, [24, "Rig not found"]);
      this._close();
      return;
    }

    if (!rig.proxyToken || password !== rig.proxyToken) {
      logger.warn({ rigId }, "stratum:downstream legacy auth: bad credentials");
      this._recordAuthFailure(rigId, "Bad credentials — token mismatch");
      this._reply(msg.id, false, [24, "Bad credentials"]);
      this._close();
      return;
    }

    await this._completeAuth(msg, rig);
  }

  /**
   * New auth: worker = "{stratumUsername}.{rigname}", password = anything.
   * Authentication is based solely on the globally-unique stratumUsername.
   * If no rig with that stratumName exists under the user's account, one is
   * auto-created with approvalStatus=pending so the admin can configure it.
   */
  private async _authorizeByStratumToken(
    msg: JsonRpcMessage,
    workerStr: string,
    _password: string,
    firstDotIdx: number,
  ): Promise<void> {
    const stratumUsername = workerStr.slice(0, firstDotIdx).toLowerCase();
    const rigname = workerStr.slice(firstDotIdx + 1);

    if (!stratumUsername || !rigname) {
      logger.warn({ workerStr }, "stratum:downstream new auth: empty username or rigname");
      this._recordAuthFailure(null, `Bad worker format: ${workerStr}`);
      this._reply(msg.id, false, [24, "Bad worker format — both username and rigname are required"]);
      this._close();
      return;
    }

    // Look up user by stratumUsername. Password is not checked —
    // the unique username is sufficient proof of identity.
    const [user] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.stratumUsername, stratumUsername));

    if (!user) {
      logger.warn({ stratumUsername }, "stratum:downstream new auth: username not found");
      this._recordAuthFailure(null, `Unknown stratum username: ${stratumUsername}`);
      this._reply(msg.id, false, [24, "Unknown username"]);
      this._close();
      return;
    }

    // Find or auto-create the rig for this (ownerId, stratumName) pair.
    const [existingRig] = await db
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
      .where(and(eq(rigsTable.ownerId, user.id), eq(rigsTable.stratumName, rigname)));

    if (existingRig) {
      await this._completeAuth(msg, { ...existingRig, ownerId: user.id }, rigname);
      return;
    }

    // Auto-create: use the first algorithm as a placeholder — admin sets the
    // correct algorithm and hashrate during the approval process.
    const [firstAlgo] = await db
      .select({ id: algorithmsTable.id })
      .from(algorithmsTable)
      .orderBy(asc(algorithmsTable.id))
      .limit(1);

    if (!firstAlgo) {
      logger.error("stratum:downstream new auth: no algorithms in DB — cannot auto-create rig");
      this._reply(msg.id, false, [20, "Server configuration error"]);
      this._close();
      return;
    }

    const proxyToken = randomBytes(32).toString("hex");
    // Use ON CONFLICT DO NOTHING to handle concurrent first-connect races on the
    // (ownerId, stratumName) unique index, then re-select the winning row.
    await db
      .insert(rigsTable)
      .values({
        ownerId: user.id,
        algorithmId: firstAlgo.id,
        name: rigname,
        description: "",
        hashrate: "0",
        approvalStatus: "pending",
        status: "offline",
        proxyToken,
        stratumName: rigname,
      })
      .onConflictDoNothing();

    const [autoRig] = await db
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
      .where(and(eq(rigsTable.ownerId, user.id), eq(rigsTable.stratumName, rigname)));

    if (!autoRig) {
      logger.error({ ownerId: user.id, rigname }, "stratum:downstream auto-create + re-select failed");
      this._reply(msg.id, false, [20, "Server error creating rig"]);
      this._close();
      return;
    }

    logger.info(
      { ownerId: user.id, stratumUsername, rigname, rigId: autoRig.id },
      "stratum:downstream auto-created rig on first connect",
    );

    await this._completeAuth(msg, { ...autoRig, ownerId: user.id }, rigname);
  }

  /** Shared post-authentication logic for both legacy and new auth paths. */
  private async _completeAuth(msg: JsonRpcMessage, rig: {
    id: number;
    ownerId: number;
    name: string;
    stratumHost: string;
    stratumPort: number;
    stratumUser: string;
    stratumPassword: string;
  }, stratumName?: string): Promise<void> {
    this.rigId = rig.id;
    this.ownerId = rig.ownerId;
    this.authorized = true;
    proxyState.addRig(rig.id, rig.ownerId, this, rig.name);

    // Persist online state and last-seen timestamp so admin can track connectivity.
    await db
      .update(rigsTable)
      .set({ isOnline: true, lastSeenAt: new Date() })
      .where(eq(rigsTable.id, rig.id));

    const activeRental = await this._findActiveRental(rig.id, rig.ownerId, stratumName);
    this.rentalId = activeRental?.id ?? null;
    proxyState.setRigAuthorized(rig.id, this.rentalId);

    this._reply(msg.id, true);
    logger.info(
      { rigId: rig.id, ownerId: rig.ownerId, rentalId: this.rentalId },
      "stratum:downstream authorized",
    );

    if (activeRental) {
      this.isFallback = false;
      logger.info(
        { rigId: rig.id, rentalId: activeRental.id, poolUrl: activeRental.poolUrl },
        "stratum:downstream ROUTING → RENTER POOL",
      );
      await this._startUpstream(activeRental);
    } else if (rig.stratumHost && rig.stratumPort > 0) {
      logger.info(
        { rigId: rig.id, stratumHost: rig.stratumHost, stratumPort: rig.stratumPort },
        "stratum:downstream ROUTING → OWNER FALLBACK POOL (no active rental)",
      );
      await this._startFallbackUpstream(rig);
    } else {
      this._notify("mining.set_difficulty", [1]);
      logger.info({ rigId: rig.id }, "stratum:downstream ROUTING → IDLE (no rental, no fallback pool configured)");
    }
  }

  private async _findActiveRental(rigId: number, ownerId: number, stratumName?: string) {
    const now = new Date();

    // Primary: look up by the exact rigId registered in the marketplace.
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

    if (rental) {
      if (rental.endsAt >= now) {
        logger.info(
          { rigId, rentalId: rental.id, poolUrl: rental.poolUrl, endsAt: rental.endsAt },
          "stratum:_findActiveRental PRIMARY HIT — routing to renter pool",
        );
        return rental;
      }
      logger.warn(
        { rigId, rentalId: rental.id, endsAt: rental.endsAt, now },
        "stratum:_findActiveRental primary found rental but endsAt is PAST — not routing",
      );
    } else {
      logger.info(
        { rigId, ownerId, stratumName },
        "stratum:_findActiveRental primary miss — no active rental for rigId, trying stratumName fallback",
      );
    }

    // Secondary fallback: if we know the miner's stratumName (rigname), find
    // the rig that owns that stratumName and look up its rental. This handles
    // the case where an owner has multiple rigs — we can pinpoint the correct
    // rental rather than returning an arbitrary one via the ownerId fallback.
    if (stratumName) {
      const [byStratumName] = await db
        .select({
          id: rentalsTable.id,
          poolUrl: rentalsTable.poolUrl,
          poolWorker: rentalsTable.poolWorker,
          poolPassword: rentalsTable.poolPassword,
          endsAt: rentalsTable.endsAt,
          matchedRigId: rigsTable.id,
        })
        .from(rentalsTable)
        .innerJoin(rigsTable, eq(rigsTable.id, rentalsTable.rigId))
        .where(
          and(
            eq(rigsTable.ownerId, ownerId),
            eq(rigsTable.stratumName, stratumName),
            eq(rentalsTable.status, "active"),
          ),
        );

      if (byStratumName) {
        if (byStratumName.endsAt >= now) {
          logger.warn(
            { shadowRigId: rigId, ownerId, stratumName, rentalId: byStratumName.id, matchedRigId: byStratumName.matchedRigId },
            "stratum:_findActiveRental STRATUMNAME FALLBACK HIT — shadow rig matched by stratumName",
          );
          return byStratumName;
        }
        logger.warn(
          { rigId, ownerId, stratumName, rentalId: byStratumName.id, endsAt: byStratumName.endsAt, now },
          "stratum:_findActiveRental stratumName fallback found rental but endsAt is PAST → fallback pool",
        );
        return null;
      }
    }

    // Last resort: any active rental for this owner. Only used when stratumName
    // is unknown (legacy auth) or when the owner has a single rig.
    // WARNING: if the owner has multiple rigs with active rentals this may
    // return the wrong rental — prefer the stratumName path above.
    const [ownerRental] = await db
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
          eq(rentalsTable.ownerId, ownerId),
          eq(rentalsTable.status, "active"),
        ),
      );

    if (!ownerRental) {
      logger.info(
        { rigId, ownerId },
        "stratum:_findActiveRental fallback miss — no active rental for ownerId either → fallback pool",
      );
      return null;
    }
    if (ownerRental.endsAt < now) {
      logger.warn(
        { rigId, ownerId, rentalId: ownerRental.id, endsAt: ownerRental.endsAt, now },
        "stratum:_findActiveRental fallback found rental but endsAt is PAST → fallback pool",
      );
      return null;
    }

    logger.warn(
      { shadowRigId: rigId, ownerId, rentalId: ownerRental.id, poolUrl: ownerRental.poolUrl },
      "stratum:_findActiveRental OWNER FALLBACK HIT — last resort ownerId lookup (shadow rig, single-rig owner)",
    );
    return ownerRental;
  }

  async activateRental(rentalId: number, _poolUrl: string, _poolWorker: string, _poolPassword: string): Promise<void> {
    // Destroy the current upstream (owner's fallback pool) so shares stop going there.
    if (this.upstream) {
      this.upstream.destroy();
      this.upstream = null;
    }
    this.submitBuffer = [];
    this.isFallback = false;
    this.rentalId = rentalId;
    if (this.rigId != null) proxyState.setRigAuthorized(this.rigId, rentalId);

    // Force-disconnect the miner so it reconnects from scratch.
    //
    // Rationale: many ASIC firmwares (Antminer, Whatsminer, …) do NOT honour
    // mid-session `mining.set_extranonce` messages.  If we start a fresh
    // upstream to the renter's pool while the miner is still subscribed to the
    // owner's pool, the miner keeps using the old extranonce prefix, the
    // renter's pool rejects every share as invalid, and effective hashrate stays
    // at 0.
    //
    // By closing the TCP connection here we force the miner to re-connect
    // (typically within 1-3 seconds).  On reconnect `_completeAuth` is called,
    // `_findActiveRental` sees the now-active rental and `_startUpstream`
    // creates a fresh pool subscription — the miner receives the correct
    // extranonce from the renter's pool at the start of the new session.
    logger.info(
      { rigId: this.rigId, rentalId },
      "stratum:downstream rental activated — force-closing miner for clean reconnect (extranonce refresh)",
    );
    this._close();
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
    // Remove the share window so the flush loop stops inserting samples for this finished rental.
    if (prevRentalId != null) {
      proxyState.removeShareWindow(prevRentalId);
    }

    // Force-close the miner so it reconnects and picks up the owner's fallback pool
    // with a fresh subscription (correct extranonce). Same reasoning as activateRental —
    // many ASIC firmwares don't honour mid-session mining.set_extranonce.
    logger.info({ rigId: this.rigId, prevRentalId }, "stratum:downstream rental deactivated — force-closing miner for clean reconnect");
    this._close();
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

    // Guard: abort if the session was destroyed or a rental started while
    // we were awaiting the DB read (prevents fallback overwriting an active rental).
    if (this.destroyed || this.rentalId !== null) return;
    if (rig?.stratumHost && rig.stratumPort > 0) {
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
    const upstream = new UpstreamClient(poolUrl, worker, password, 0, this.versionRollingMask ?? undefined);
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

    upstream.on("authFailed", () => {
      proxyState.setUpstreamAuthFailed(rigId, true);
      logger.warn({ rigId }, "stratum:downstream fallback pool rejected worker credentials");
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
      this.versionRollingMask ?? undefined,
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

    upstream.on("authFailed", () => {
      if (this.rigId != null) {
        proxyState.setUpstreamAuthFailed(this.rigId, true);
        logger.warn({ rigId: this.rigId, rentalId }, "stratum:downstream pool rejected worker credentials");
      }
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
    for (const { jobId, extranonce2, ntime, nonce, versionBits, diff } of buffered) {
      if (!this.upstream) break; // Upstream went away again
      let accepted = false;
      try {
        accepted = await this.upstream.submitShare(jobId, extranonce2, ntime, nonce, versionBits);
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
    // ASICBoost version-rolling: miner appends version bits as param[5]
    const versionBits = params[5] ? params[5] : undefined;

    if (!this.upstream) {
      // Return error only when there is no rental AND no fallback configured.
      if (this.rentalId == null && !this.isFallback) {
        this._reply(msg.id, false, [21, "No active rental"]);
        return;
      }
      // Upstream temporarily unavailable — buffer the share for replay.
      if (this.submitBuffer.length < SUBMIT_BUFFER_MAX) {
        this.submitBuffer.push({ jobId, extranonce2, ntime, nonce, versionBits, diff: this.currentDifficulty });
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
        versionBits,
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
