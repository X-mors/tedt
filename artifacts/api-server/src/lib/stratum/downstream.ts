import * as net from "node:net";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { eq, and, asc } from "drizzle-orm";
import { db, rigsTable, rentalsTable, proxyAuthFailuresTable, usersTable, algorithmsTable } from "@workspace/db";
import { logger } from "../logger";
import { proxyState } from "./state";
import { flushAndRemoveRentalWindow } from "./persistence";
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

/** Generate a random proxy-assigned extranonce1 of `byteLen` bytes (default 4). */
function makeExtranonce1(byteLen = 4): string {
  return randomBytes(byteLen).toString("hex");
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
  /** Miner-requested minimum difficulty from mining.configure (`minimum-difficulty.value`).
   *  We must never push a set_difficulty below this — many proxies (stratum-proxy)
   *  hard-disconnect when their floor is violated. */
  private minDifficulty = 1;
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
  /** Most recent extranonce1 propagated to the miner. Kept for mid-session
   *  change detection only (force-close / set_extranonce paths). */
  private upstreamExtranonce1: string | null = null;
  /**
   * When non-null, the miner's `mining.subscribe` reply has NOT been sent yet.
   * We defer it until the upstream pool completes its own subscribe handshake
   * and gives us its real extranonce1 + extranonce2_size. This is the only
   * correct proxy behaviour for legacy miners (S9, cgminer, etc.) that use the
   * extranonce values from the subscribe reply for the entire session and silently
   * ignore mining.set_extranonce. If we guess the wrong values and later correct
   * them with set_extranonce, the miner keeps hashing with the wrong prefix and
   * the pool rejects every share → hashrate = 0.
   */
  /**
   * True when this session was accepted on the legacy SHA-256 listener (no
   * ASICBoost). Forces version-rolling OFF at mining.configure regardless of
   * what the miner asks, and constrains rigs to the legacy `sha256` algorithm.
   */
  private readonly legacyMode: boolean;
  constructor(private readonly socket: net.Socket, opts: { legacyMode?: boolean } = {}) {
    super();
    this.legacyMode = opts.legacyMode === true;
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

  /**
   * Send mining.set_difficulty respecting the miner-negotiated minimum.
   * Many proxies (e.g. stratum-proxy) hard-disconnect when the server pushes
   * a difficulty below the floor declared in mining.configure.
   */
  private _setDifficulty(diff: number): void {
    const safe = Math.max(diff, 1);
    this.currentDifficulty = safe;
    this._notify("mining.set_difficulty", [safe]);
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
    const params = (msg.params?.[1] ?? {}) as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const ext of extensions) {
      if (ext === "version-rolling") {
        if (this.legacyMode) {
          // Legacy SHA-256 listener: refuse version-rolling unconditionally so
          // the miner runs in plain Stratum V1 mode and the upstream pool
          // never sees any rolled-version bits it can't verify.
          result["version-rolling"] = false;
          continue;
        }
        // Honor the miner's requested mask (intersected with our supported bits).
        // Hardcoding 1fffe000 confused proxies that negotiated a smaller mask.
        const requested = typeof params["version-rolling.mask"] === "string"
          ? (params["version-rolling.mask"] as string)
          : "1fffe000";
        const requestedBits = parseInt(requested, 16);
        const supportedBits = 0x1fffe000;
        const negotiated = (Number.isFinite(requestedBits) ? requestedBits : supportedBits) & supportedBits;
        this.versionRollingMask = negotiated.toString(16).padStart(8, "0");
        const reqMinBits = params["version-rolling.min-bit-count"];
        const minBits = typeof reqMinBits === "number" ? reqMinBits : 2;
        result["version-rolling"] = true;
        result["version-rolling.mask"] = this.versionRollingMask;
        result["version-rolling.min-bit-count"] = minBits;
      } else if (ext === "minimum-difficulty") {
        // Decline the floor: we want the miner to follow the upstream pool's
        // difficulty (vardiff) verbatim, not be clamped to a hard minimum.
        result["minimum-difficulty"] = false;
      } else if (ext === "subscribe-extranonce") {
        result["subscribe-extranonce"] = true;
      } else {
        result[ext] = false;
      }
    }
    logger.debug(
      { rigId: this.rigId, extensions, minDifficulty: this.minDifficulty, mask: this.versionRollingMask },
      "stratum:downstream mining.configure",
    );
    this._reply(msg.id, result);
  }

  private async _handleSubscribe(msg: JsonRpcMessage): Promise<void> {
    if (this.subscribed) {
      this._reply(msg.id, null, [20, "Already subscribed"]);
      return;
    }
    this.subscribed = true;

    // Reply immediately — we CANNOT defer because many ASIC firmwares (S9,
    // cgminer, bfgminer) wait for the subscribe reply before sending authorize.
    //
    // Key insight: mining.set_extranonce is safe when it changes only the VALUE
    // of extranonce1 (same byte-length) and does not change extranonce2_size.
    // ANY size change in set_extranonce invalidates the coinbase template and
    // most firmwares disconnect. So we must use the correct byte-length and
    // e2size in this subscribe reply to avoid size-changing set_extranonce later.
    //
    // We achieve this by storing a per-IP "extranonce format hint" each time a
    // session closes after learning the pool's real extranonce format. On the
    // very first connect (no hint) we default to 4B / e2size=4, accept one
    // force-close, and from the second connect onwards the hint is accurate.
    const remoteIp = this.socket.remoteAddress ?? "";
    const hint = proxyState.getExtranonceHint(remoteIp);
    const e1ByteLen = hint?.e1ByteLen ?? 4;
    this.extranonce2Size = hint?.e2size ?? 4;
    this.extranonce1 = makeExtranonce1(e1ByteLen);

    this._reply(msg.id, [
      [["mining.set_difficulty", `sub-diff-${this.msgIdCounter}`]],
      this.extranonce1,
      this.extranonce2Size,
    ]);
    this._setDifficulty(this.currentDifficulty);
    logger.debug(
      { rigId: this.rigId, e1: this.extranonce1, e2size: this.extranonce2Size, hintUsed: hint != null },
      "stratum:downstream subscribe acknowledged — awaiting upstream pool extranonce",
    );
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

    // Auto-create: pick the algorithm matching the listener mode so the
    // newly-created rig is consistent with the port the miner is using.
    //   • Legacy port → slug "sha256" (no ASICBoost).
    //   • Default port → slug "sha256asicboost" if present, else fall back to
    //     the first algorithm by id (covers fresh dev DBs without that slug).
    const desiredSlug = this.legacyMode ? "sha256" : "sha256asicboost";
    const [matchedAlgo] = await db
      .select({ id: algorithmsTable.id })
      .from(algorithmsTable)
      .where(eq(algorithmsTable.slug, desiredSlug));
    const [fallbackAlgo] = matchedAlgo
      ? [matchedAlgo]
      : await db
          .select({ id: algorithmsTable.id })
          .from(algorithmsTable)
          .orderBy(asc(algorithmsTable.id))
          .limit(1);
    const firstAlgo = fallbackAlgo;

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
    // Enforce the algorithm/listener separation: a rig listed as "sha256"
    // (legacy, no ASICBoost) must connect on the legacy port (3334), and
    // any other algorithm — including "sha256asicboost" — must connect on
    // the default port (3333). Mismatches are rejected with a clear hint.
    const [algoRow] = await db
      .select({ slug: algorithmsTable.slug })
      .from(algorithmsTable)
      .innerJoin(rigsTable, eq(rigsTable.algorithmId, algorithmsTable.id))
      .where(eq(rigsTable.id, rig.id));
    const slug = algoRow?.slug ?? null;
    const isLegacySlug = slug === "sha256";
    if (this.legacyMode && !isLegacySlug) {
      logger.warn(
        { rigId: rig.id, slug, port: "legacy" },
        "stratum:downstream rejected: rig algorithm requires the default ASICBoost port",
      );
      this._recordAuthFailure(rig.id, `Algorithm ${slug ?? "?"} not allowed on legacy port`);
      this._reply(msg.id, false, [
        24,
        "This rig is listed for ASICBoost — connect on the default Stratum port instead of the legacy port.",
      ]);
      this._close();
      return;
    }
    // Legacy sha256 rigs are allowed on EITHER port. Old hardware (S9, etc.)
    // may be hard-coded to port 3333 and cannot easily change ports. These
    // miners never send mining.configure, so versionRollingMask stays null
    // and the upstream is created without version-rolling — correct behaviour.
    // We only keep the reverse check: sha256asicboost rigs MUST use port 3333
    // (already enforced above via the legacyMode && !isLegacySlug block).

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
      this._setDifficulty(1);
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
    // Flush any unflushed share counters into the rentals row, then remove
    // the share window so the flush loop stops inserting samples. Fire and
    // forget — deactivateRental is sync and the persist is best-effort; any
    // failure is logged and the next periodic flush retries.
    if (prevRentalId != null) {
      void flushAndRemoveRentalWindow(prevRentalId);
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
      this.upstream.removeAllListeners();
      this.upstream.destroy();
      this.upstream = null;
      this.isFallback = false;
      proxyState.setUpstreamConnected(this.rigId, false);
    }
    // Also evict any parked fallback so the next reconnect uses the new config.
    proxyState.removeParkedFallbackUpstream(this.rigId);
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

    // Prefer a parked fallback upstream from a recent natural disconnect.
    const claimed = proxyState.claimFallbackUpstream(rig.id);
    if (claimed) {
      this.upstream = claimed;
      this._wireFallbackUpstreamEvents(rig.id);
      const e1 = claimed.getExtranonce1();
      const e2size = claimed.getExtranonce2Size();
      if (e1) {
        this._applyUpstreamExtranonce(e1, e2size, "parked-fallback-claimed");
        proxyState.setUpstreamConnected(rig.id, true);
        void this._flushSubmitBuffer();
      }
      logger.info(
        { rigId: rig.id, poolUrl, worker },
        "stratum:downstream reused parked fallback upstream — miner gets pool extranonce immediately",
      );
      return;
    }

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
      this._setDifficulty(diff);
    });

    upstream.on("notify", (params: unknown) => {
      this.lastJobId = Array.isArray(params) ? String(params[0]) : null;
      this._notify("mining.notify", params as unknown[]);
    });

    upstream.on("subscribed", ({ extranonce1, extranonce2Size }: { extranonce1: string; extranonce2Size: number }) => {
      this._applyUpstreamExtranonce(extranonce1 ?? this.extranonce1, extranonce2Size, "subscribed");
    });

    upstream.on("setExtranonce", ({ extranonce1, extranonce2Size }: { extranonce1: string; extranonce2Size: number }) => {
      this._applyUpstreamExtranonce(extranonce1, extranonce2Size, "set_extranonce");
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

    // Prefer a parked upstream from a recent natural disconnect (within
    // RECONNECT_GRACE_MS). The parked upstream is still subscribed to the pool
    // with a stable extranonce1/extranonce2_size — reusing it means we can
    // fulfil the pending subscribe reply immediately without waiting for a
    // fresh pool round-trip, and the miner starts mining with the correct
    // extranonce on the very first share submission.
    const claimed = proxyState.claimParkedUpstream(rental.id);
    if (claimed) {
      this.upstream = claimed;
      this._wireUpstreamEvents(rental.id);
      const e1 = claimed.getExtranonce1();
      const e2size = claimed.getExtranonce2Size();
      if (e1) {
        // Pool's real extranonce is known immediately — update the miner now
        // so it switches to the correct extranonce without waiting for pool events.
        this._applyUpstreamExtranonce(e1, e2size, "parked-upstream-claimed");
        proxyState.setUpstreamConnected(this.rigId, true);
        void this._flushSubmitBuffer();
      }
      logger.info(
        { rigId: this.rigId, rentalId: rental.id, e1, e2size },
        "stratum:downstream reused parked upstream — miner updated with pool extranonce immediately",
      );
      return;
    }

    // No parked upstream: open a fresh connection. The pool will respond to
    // our mining.subscribe with its real extranonce1/extranonce2_size, which
    // _applyUpstreamExtranonce will then forward to the miner via set_extranonce.
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
      if (this.rigId != null) {
        proxyState.setCurrentDifficulty(rentalId, diff);
      }
      this._setDifficulty(diff);
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
    const prevExtranonce1 = this.extranonce1;
    const prevSize = this.extranonce2Size;

    // Always track the pool's real extranonce1 for internal record-keeping.
    this.upstreamExtranonce1 = newExtranonce1;

    // No-op if nothing visible to the miner actually changed.
    if (newExtranonce1 === prevExtranonce1 && extranonce2Size === prevSize) {
      logger.debug(
        { rigId: this.rigId, source, extranonce2Size },
        "stratum:downstream upstream extranonce unchanged — no set_extranonce needed",
      );
      return;
    }

    // SAFETY CHECK: if the pool's extranonce1 byte-length or extranonce2_size
    // differs from what we told the miner at subscribe time, sending
    // set_extranonce would change the coinbase template length — nearly all ASIC
    // firmwares disconnect immediately when this happens (Antminer S9 / S19,
    // Whatsminer M30, etc.). Instead we store the pool's format as an IP hint
    // and force-close so the miner reconnects. On the next connection the hint
    // is used to generate a subscribe reply whose extranonce sizes already match
    // the pool → set_extranonce will only change the VALUE (safe).
    const ourE1ByteLen = prevExtranonce1.length / 2;
    const poolE1ByteLen = newExtranonce1.length / 2;
    if (poolE1ByteLen !== ourE1ByteLen || extranonce2Size !== prevSize) {
      const remoteIp = this.socket.remoteAddress ?? "";
      if (remoteIp) proxyState.storeExtranonceHint(remoteIp, newExtranonce1, extranonce2Size);
      logger.info(
        {
          rigId: this.rigId, source,
          ourE1ByteLen, poolE1ByteLen,
          ourE2size: prevSize, poolE2size: extranonce2Size,
          ip: remoteIp,
        },
        "stratum:downstream pool extranonce size mismatch — stored hint and force-closing for clean reconnect",
      );
      this._close();
      return;
    }

    // Sizes match → only the VALUE of extranonce1 changed (safe for all firmwares).
    this.extranonce1 = newExtranonce1;
    this.extranonce2Size = extranonce2Size;

    logger.info(
      { rigId: this.rigId, source, prevExtranonce1, newExtranonce1 },
      "stratum:downstream upstream extranonce value changed — forwarding mining.set_extranonce (safe, same sizes)",
    );
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

    // Verify: log the difficulty-weighted hashrate contribution of this share.
    // hashrate = diff × 2^32 / elapsedSec — we log the diff so operators can
    // confirm the actual pool-set difficulty (not just share count) is used.
    logger.debug(
      {
        rigId: this.rigId,
        rentalId: this.rentalId,
        isFallback: this.isFallback,
        accepted,
        shareDiff: diff,
        hashrateContribGHs: ((diff * 4294967296) / 1e9).toFixed(3),
        formula: `hashrate = Σ(diff × 2³²) / elapsed`,
      },
      "stratum:downstream share recorded",
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
      proxyState.removeRig(this.rigId, this);
      // Mark rig offline in DB (best-effort — do not await to avoid blocking).
      void db
        .update(rigsTable)
        .set({ isOnline: false })
        .where(eq(rigsTable.id, this.rigId));
    }
    // Refresh the per-IP extranonce hint so the NEXT connect from this machine
    // gets the correct e1 byte-length and e2size in the subscribe reply.
    // We store it here (at natural close) AND at force-close in _applyUpstreamExtranonce.
    if (this.upstreamExtranonce1 && this.rigId != null) {
      const remoteIp = this.socket.remoteAddress ?? "";
      if (remoteIp) proxyState.storeExtranonceHint(remoteIp, this.upstreamExtranonce1, this.extranonce2Size);
    }

    if (this.upstream != null) {
      // Remove all downstream-specific listeners before parking so the parked
      // upstream doesn't invoke callbacks on this (soon-to-be-GC'd) session.
      // If the upstream emits events while parked they'll silently go nowhere
      // until the next session claims it and wires fresh listeners.
      this.upstream.removeAllListeners();
      if (this.isFallback && this.rigId != null) {
        // Fallback upstream: park keyed by rigId.
        proxyState.parkFallbackUpstream(this.rigId, this.upstream);
        logger.debug(
          { rigId: this.rigId },
          "stratum:downstream parked fallback upstream for reconnect grace period",
        );
      } else if (!this.isFallback && this.rentalId != null) {
        // Rental upstream: park keyed by rentalId.
        proxyState.parkUpstream(this.rentalId, this.upstream);
        logger.debug(
          { rigId: this.rigId, rentalId: this.rentalId },
          "stratum:downstream parked rental upstream for reconnect grace period",
        );
      } else {
        this.upstream.destroy();
      }
      this.upstream = null;
    }
    logger.info({ rigId: this.rigId }, "stratum:downstream closed");
    this.emit("close");
  }
}
