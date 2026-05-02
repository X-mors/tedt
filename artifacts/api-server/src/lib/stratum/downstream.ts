import * as net from "node:net";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { eq, and, asc } from "drizzle-orm";
import { db, rigsTable, rentalsTable, proxyAuthFailuresTable, usersTable, algorithmsTable } from "@workspace/db";
import { logger } from "../logger";
import { proxyState } from "./state";
import { UpstreamClient } from "./upstream";
import type { JsonRpcMessage, RecordedShare } from "./types";


/** Maximum number of shares buffered while upstream is temporarily unavailable. */
const SUBMIT_BUFFER_MAX = 64;

/**
 * Stores share parameters for replay after upstream reconnects.
 * We do NOT store the original request ID so there is no risk of sending a
 * duplicate reply to the miner — the miner already received `result: true`.
 *
 * `handle` is the optimistic record made AT BUFFER TIME so the rolling stats
 * buffer continues to receive samples even while upstream is disconnected
 * (otherwise the live hashrate decays to 0 during any pool blip even though
 * the miner is happily producing shares). On replay, if the pool ultimately
 * rejects, we downgrade this handle in place — we do NOT record the share
 * again (which would double-count).
 */
interface BufferedSubmit {
  jobId: string;
  extranonce2: string;
  ntime: string;
  nonce: string;
  versionBits: string | undefined;
  diff: number;
  handle: RecordedShare | null;
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
  /** Timestamp of last data written TO the miner (write side). Used by keep-alive. */
  private lastSentMs = Date.now();
  /** Most recent extranonce1 propagated to the miner. Used to detect mid-session changes
   *  on upstream resubscribe — many ASIC firmwares ignore mining.set_extranonce, so on a
   *  real change we force-close the miner socket so it picks up the new prefix from a
   *  fresh subscribe handshake. */
  private upstreamExtranonce1: string | null = null;
  /** Diagnostic: count first N messages in/out for handshake debugging. */
  private _diagInCount = 0;
  private _diagOutCount = 0;
  private static readonly _DIAG_MAX = 14;

  constructor(private readonly socket: net.Socket) {
    super();
    socket.setEncoding("utf8");
    // 10-min idle timeout — tolerates high-difficulty pools that produce only
    // a share every several minutes. Detection of truly dead sockets is handled
    // by setKeepAlive() probes plus the inactivity check below.
    socket.setTimeout(600_000);
    // OS-level TCP keepalive: probes after 60 s of socket inactivity. If no ACK
    // within the OS retry budget (~30-60 s) the socket errors and we close cleanly.
    socket.setKeepAlive(true, 60_000);
    // setNoDelay disables Nagle's algorithm so small Stratum messages (typically
    // <200 bytes) are sent immediately rather than batched. Reduces miner-side
    // perceived latency, important because many ASIC firmwares time out shares
    // they consider "old" before the pool reply arrives.
    socket.setNoDelay(true);

    // Detect dead connections (e.g. power cut): if the miner sends no data for
    // 10 minutes we consider it gone. Lenient because high-difficulty pools may
    // produce shares only every several minutes.
    const INACTIVITY_MS = 10 * 60_000;
    const _inactivityCheck = setInterval(() => {
      if (socket.destroyed) { clearInterval(_inactivityCheck); return; }
      if (Date.now() - this.lastReceivedMs > INACTIVITY_MS) {
        logger.info(
          { rigId: this.rigId, sinceLastDataMs: Date.now() - this.lastReceivedMs },
          "stratum:downstream INACTIVITY_TIMEOUT — closing dead connection",
        );
        clearInterval(_inactivityCheck);
        this._close();
      }
    }, 60_000);
    socket.once("close", () => clearInterval(_inactivityCheck));

    // Note: previously we ran a 90-second stratum-level keep-alive that
    // re-sent mining.set_difficulty. That turned out to disturb some ASIC
    // firmwares which restart their internal job tracker on every
    // set_difficulty, causing the share window to repeatedly reset and
    // making the live hashrate appear frozen. We now rely on the
    // OS-level TCP keepalive set above (60s) to keep NAT tables warm,
    // and let the natural mining.notify traffic from the upstream pool
    // act as the application-level keep-alive.

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
      const line = JSON.stringify(msg);
      if (this._diagOutCount < DownstreamSession._DIAG_MAX) {
        this._diagOutCount++;
        const preview = line.length > 240 ? line.slice(0, 240) + "…" : line;
        logger.info(
          { rigId: this.rigId, n: this._diagOutCount, msg: preview },
          "stratum:diag OUT",
        );
      }
      this.socket.write(line + "\n");
      this.lastSentMs = Date.now();
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

    if (this._diagInCount < DownstreamSession._DIAG_MAX) {
      this._diagInCount++;
      const preview = JSON.stringify({ id: msg.id, method: msg.method, params: msg.params });
      logger.info(
        { rigId: this.rigId, n: this._diagInCount, msg: preview.length > 240 ? preview.slice(0, 240) + "…" : preview },
        "stratum:diag IN",
      );
    }

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
      case "mining.suggest_difficulty": {
        // Forward the miner's preferred starting difficulty to the upstream pool
        // when one is available. Most pools honour this hint to avoid starting
        // very-fast miners at vardiff=1, which would create a flood of low-diff
        // shares and may cause the pool to throttle/disconnect the worker.
        const params = (msg.params ?? []) as unknown[];
        const suggested = Number(params[0]);
        if (this.upstream && Number.isFinite(suggested) && suggested > 0) {
          this.upstream.suggestDifficulty(suggested);
          logger.debug({ rigId: this.rigId, suggested }, "stratum:downstream forwarded suggest_difficulty");
        }
        break;
      }
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

    // -----------------------------------------------------------------------
    // Determine auth mode:
    //   Legacy: "rig-{number}" or "rig-{number}.suffix"  → authenticate by proxyToken
    //   New:    "{stratumUsername}.{rigname}"              → authenticate by stratumUsername (any password accepted)
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
      await this._completeAuth(msg, { ...existingRig, ownerId: user.id });
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
    // Auto-approve so the rig is immediately visible — admin gate removed.
    await db
      .insert(rigsTable)
      .values({
        ownerId: user.id,
        algorithmId: firstAlgo.id,
        name: rigname,
        description: "",
        hashrate: "0",
        approvalStatus: "approved",
        approvedAt: new Date(),
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

    await this._completeAuth(msg, { ...autoRig, ownerId: user.id });
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
  }): Promise<void> {
    this.rigId = rig.id;
    this.ownerId = rig.ownerId;
    this.authorized = true;
    proxyState.addRig(rig.id, rig.ownerId, this, rig.name);

    // Persist online state and last-seen timestamp so admin can track connectivity.
    await db
      .update(rigsTable)
      .set({ isOnline: true, lastSeenAt: new Date() })
      .where(eq(rigsTable.id, rig.id));

    const activeRental = await this._findActiveRental(rig.id, rig.ownerId);
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

  private async _findActiveRental(rigId: number, ownerId: number) {
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
    if (rental && rental.endsAt >= now) return rental;

    // Fallback: miner may have connected under a stratumName that caused the
    // proxy to auto-create a shadow rig with a different ID.  Search by ownerId
    // so we can still route to the renter's pool when the IDs don't match.
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
    if (!ownerRental || ownerRental.endsAt < now) return null;

    logger.warn(
      { shadowRigId: rigId, ownerId, rentalId: ownerRental.id },
      "stratum:downstream _findActiveRental fallback via ownerId — stratumName mismatch",
    );
    return ownerRental;
  }

  async activateRental(rentalId: number, _poolUrl: string, _poolWorker: string, _poolPassword: string): Promise<void> {
    // Destroy the current upstream (owner's fallback pool) so shares stop going there.
    if (this.upstream) {
      this.upstream.destroy();
      this.upstream = null;
    }
    this._clearSubmitBuffer();
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

  /**
   * Live-switch the destination pool for the *current* rental without
   * deactivating it.  The new poolUrl/worker/password are expected to already
   * be persisted on the rentals row by the caller — here we just rip the
   * upstream pool socket and force-close the miner so it reconnects clean.
   * On reconnect, `_completeAuth → _findActiveRental` re-reads the rental from
   * the DB and `_startUpstream` opens a fresh subscription against the new
   * pool with a fresh extranonce, which is the only way most ASIC firmwares
   * accept new mining work.
   */
  async switchRentalPool(rentalId: number): Promise<void> {
    if (this.rentalId !== rentalId) {
      logger.warn(
        { rigId: this.rigId, rentalId, sessionRentalId: this.rentalId },
        "stratum:downstream switchRentalPool called for non-matching rental — ignoring",
      );
      return;
    }
    if (this.upstream) {
      this.upstream.destroy();
      this.upstream = null;
    }
    // CRITICAL: also evict any parked upstream from a recent natural reconnect.
    // Otherwise _startUpstream on the next reconnect would claim the parked
    // OLD-pool upstream and silently keep mining to the previous pool.
    proxyState.removeParkedUpstream(rentalId);
    this._clearSubmitBuffer();
    if (this.rigId != null) {
      proxyState.setUpstreamConnected(this.rigId, false);
      proxyState.setUpstreamAuthFailed(this.rigId, false);
    }
    logger.info(
      { rigId: this.rigId, rentalId },
      "stratum:downstream rental pool switched — force-closing miner for clean reconnect",
    );
    this._close();
  }

  deactivateRental(): void {
    const prevRentalId = this.rentalId;
    if (this.upstream) {
      this.upstream.destroy();
      this.upstream = null;
    }
    this._clearSubmitBuffer();
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
   * Called by the API after the owner saves new fallback pool settings.
   * If the miner is online and idle (no active rental) we tear down the
   * current fallback upstream (if any) and immediately reconnect with the
   * freshly-saved settings from the DB.
   * No-op when a rental is active — the rental pool takes precedence.
   */
  async reloadFallbackPool(): Promise<void> {
    if (this.destroyed || this.rentalId !== null) return;
    if (this.rigId == null) return;
    // Tear down the existing fallback upstream so we can restart with new settings.
    if (this.upstream) {
      this.upstream.destroy();
      this.upstream = null;
      this.isFallback = false;
      proxyState.setUpstreamConnected(this.rigId, false);
    }
    // Force the miner to reconnect for a clean stratum subscription with the
    // new pool's extranonce. Many ASIC firmwares (Antminer, Whatsminer, …) do
    // NOT honour mid-session `mining.set_extranonce`, so without a clean
    // reconnect the new pool would reject every share as invalid and the
    // owner would see "saved" but no shares delivered to the new pool.
    // _completeAuth → _connectFallbackIfConfigured will pick up the new
    // settings from the DB on reconnect.
    logger.info(
      { rigId: this.rigId },
      "stratum:downstream fallback pool reloaded — force-closing miner for clean reconnect",
    );
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
      this._applyUpstreamExtranonce(extranonce1, extranonce2Size, "subscribed");
    });

    upstream.on("setExtranonce", ({ extranonce1, extranonce2Size }: { extranonce1: string; extranonce2Size: number }) => {
      this._applyUpstreamExtranonce(extranonce1, extranonce2Size, "set_extranonce");
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
  /**
   * Apply a new extranonce1/extranonce2Size from the upstream pool and notify
   * the miner via mining.set_extranonce.
   *
   * NOTE: We previously force-closed the downstream socket whenever the upstream
   * extranonce changed mid-session, on the theory that some ASIC firmwares
   * ignore mid-session set_extranonce. In practice this caused a tight
   * disconnect loop because every transient upstream reconnect (which is
   * normal during a multi-hour rental) hands out a fresh extranonce1, kicking
   * the miner repeatedly and freezing the stats window. The natural fallback
   * — letting the miner mine a few invalid shares until it resubscribes on
   * its own — is far less disruptive than ripping the TCP session every time.
   */
  private _applyUpstreamExtranonce(extranonce1: string, extranonce2Size: number, source: string): void {
    const newExtranonce1 = extranonce1 ?? this.extranonce1;
    const previous = this.upstreamExtranonce1;
    this.upstreamExtranonce1 = newExtranonce1;
    this.extranonce1 = newExtranonce1;
    this.extranonce2Size = extranonce2Size;

    if (previous != null && previous !== newExtranonce1) {
      logger.debug(
        { rigId: this.rigId, source, previous, newExtranonce1 },
        "stratum:downstream upstream extranonce changed — forwarding mining.set_extranonce",
      );
    }
    this._notify("mining.set_extranonce", [newExtranonce1, extranonce2Size]);
  }

  private async _flushSubmitBuffer(): Promise<void> {
    if (this.submitBuffer.length === 0) return;
    const buffered = this.submitBuffer.splice(0);
    logger.info(
      { rigId: this.rigId, count: buffered.length },
      "stratum:downstream replaying buffered shares",
    );
    for (const buf of buffered) {
      if (!this.upstream) {
        // Upstream went away again — push the unprocessed buffered share back
        // so the next reconnect can replay it. Don't rollback the handle:
        // the share IS still credited optimistically (downstream truth) and
        // will be replayed soon.
        if (this.submitBuffer.length < SUBMIT_BUFFER_MAX) {
          this.submitBuffer.push(buf);
        } else if (buf.handle) {
          // Buffer is full — give up on this one. Downgrade the optimistic
          // credit so it doesn't linger in stats forever.
          proxyState.markShareRejected(buf.handle);
        }
        continue;
      }
      let accepted = false;
      try {
        accepted = await this.upstream.submitShare(
          buf.jobId, buf.extranonce2, buf.ntime, buf.nonce, buf.versionBits,
        );
      } catch {
        accepted = false;
      }
      // The share was already recorded optimistically at buffer time; only
      // act on rejection. Do NOT recordShare again — that would double-count.
      if (!accepted && buf.handle) {
        proxyState.markShareRejected(buf.handle);
      }
    }
  }

  /**
   * Drop the buffered submit queue and downgrade every optimistic handle.
   * Used when the rental/upstream context fundamentally changes (rental
   * activate/switch/deactivate) — the buffered shares are no longer valid
   * for the new context and would be replayed against the wrong pool.
   * Without the rejection sweep the optimistic credits would leak into
   * stats with no corresponding upstream confirmation ever arriving.
   */
  private _clearSubmitBuffer(): void {
    if (this.submitBuffer.length === 0) return;
    for (const buf of this.submitBuffer) {
      if (buf.handle) proxyState.markShareRejected(buf.handle);
    }
    this.submitBuffer = [];
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
      // CRITICAL: also record optimistically NOW so the rolling stats buffer
      // keeps receiving samples during the upstream blip. Without this the
      // live hashrate decayed to 0 within ~2 min of any pool disconnect even
      // though the miner was still producing shares — the user-reported
      // "stats appear then stop updating" symptom. The handle is stored on
      // the BufferedSubmit; if the pool later rejects on replay, we
      // downgrade in place (no double-count).
      if (this.submitBuffer.length < SUBMIT_BUFFER_MAX) {
        let handle: RecordedShare | null = null;
        if (this.rigId != null && !this.isFallback) {
          handle = proxyState.recordShare(this.rigId, true, this.currentDifficulty);
        } else if (this.rigId != null && this.isFallback) {
          handle = proxyState.recordFallbackShare(this.rigId, true, this.currentDifficulty);
        }
        this.submitBuffer.push({ jobId, extranonce2, ntime, nonce, versionBits, diff: this.currentDifficulty, handle });
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

    // Credit the share at the CURRENT pool difficulty — i.e. the value of
    // the last mining.set_difficulty the pool sent us. This matches how every
    // mainstream pool (F2Pool, AntPool, ViaBTC, NiceHash, …) credits shares:
    // the share is worth the difficulty active when the pool RECEIVES it,
    // not the difficulty active when the corresponding job was first issued.
    //
    // Stratum V1 vardiff sequence that breaks per-job tracking:
    //   1. set_difficulty(D1)
    //   2. notify(jobX)             ← jobDifficulty[jobX] = D1
    //   3. set_difficulty(D2 > D1)  ← vardiff up; miner switches immediately
    //   4. miner submits share for jobX, MINED AT D2 (not D1)
    //   5. pool credits at D2; per-job lookup gives D1 → undercount by D2/D1×.
    // For the typical vardiff-up step of 8-16× this exactly produces the
    // ~13 % observed-vs-actual ratio seen in production.
    //
    // We retain getJobDifficulty as a fallback only for the rare case where
    // the upstream has not yet received its first set_difficulty (currentDiff
    // == 1 default).
    const upstreamCurrentDiff = this.upstream.getCurrentDifficulty();
    const diff =
      upstreamCurrentDiff > 1
        ? upstreamCurrentDiff
        : this.upstream.getJobDifficulty(jobId) || this.currentDifficulty;

    // OPTIMISTIC RECORDING — credit the share to the rolling buffer the
    // moment the miner submits it (downstream truth), not when the pool
    // eventually replies. Why:
    //   • The pool reply can lag by seconds (network) or never arrive
    //     (mining.submit timeout = 30s in upstream._request). Waiting for
    //     the reply meant a freshly-mining ASIC's shares appeared in the
    //     rolling buffer late or not at all, so getLiveStats() saw 6 shares
    //     in 10 minutes for a rig the pool was happily ingesting at full
    //     hashrate — yielding the "stats stuck low while pool is fine"
    //     symptom the user reported.
    //   • Real-world reject rates are <1% on a healthy ASIC, so optimistic
    //     accept introduces negligible bias; the rare rejection is corrected
    //     in-place via markShareRejected when the pool replies, which
    //     mutates the same sample so the hashrate calc immediately stops
    //     counting its difficulty contribution.
    let handle = null;
    if (this.rigId != null && !this.isFallback) {
      handle = proxyState.recordShare(this.rigId, true, diff);
    } else if (this.rigId != null && this.isFallback) {
      handle = proxyState.recordFallbackShare(this.rigId, true, diff);
    }

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

    // Pool actually rejected — downgrade the optimistic sample so the
    // rejected counter increments and the rolling-buffer hashrate calc
    // immediately stops counting that sample's difficulty. The handle
    // carries the rental/fallback scope captured at record time, so the
    // correction lands on the original window even if rental/mode changed.
    if (!accepted && handle) {
      proxyState.markShareRejected(handle);
    }
    // Refresh lastSeenAt heartbeat at most once per minute (both modes).
    if (this.rigId != null) {
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
    // Diagnostic: classify how long the connection lasted so we can spot
    // patterns like "miner reconnects every 60 s" in the logs.
    const aliveMs = Date.now() - this.lastReceivedMs;
    const pendingBuffered = this.submitBuffer.length;
    logger.info(
      {
        rigId: this.rigId,
        rentalId: this.rentalId,
        pendingBuffered,
        msSinceLastData: aliveMs,
        wasAuthorized: this.authorized,
        wasFallback: this.isFallback,
        diagIn: this._diagInCount,
        diagOut: this._diagOutCount,
        upstreamReady: this.upstream != null,
      },
      "stratum:downstream session closing",
    );
    // Roll back any pending optimistic credits BEFORE we tear down session
    // state — there is no replay path across socket close, so leaving these
    // handles untouched would inflate live/lifetime stats with shares that
    // never reached the pool. _clearSubmitBuffer() sweeps markShareRejected
    // over each handle and empties the queue.
    this._clearSubmitBuffer();
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
