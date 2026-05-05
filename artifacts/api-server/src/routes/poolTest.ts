import { Router, type IRouter } from "express";
import { z } from "zod";
import { requireAuth } from "../lib/auth";
import { UpstreamClient } from "../lib/stratum/upstream";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const PoolTestBody = z.object({
  poolUrl: z.string().min(1),
  poolWorker: z.string().min(1),
  poolPassword: z.string().optional().default("x"),
  algorithmSlug: z.string().optional(),
});

// Reasonable default mask used by all current asicboost ASICs (S19 family,
// Whatsminer, etc.). Pools that support version-rolling will accept this.
const DEFAULT_VERSION_ROLLING_MASK = "1fffe000";

/**
 * POST /pool/test
 *
 * Opens a real Stratum connection and verifies the pool is compatible with
 * the rig's algorithm.  Success requires:
 *
 * sha256asicboost rigs — ALL of:
 *   1. mining.configure response confirms version-rolling=true  (strictConfigure)
 *   2. mining.authorize accepted  ("ready")
 *   3. Pool sends at least one mining.notify  (actual job)
 *   4. Pool sends mining.set_version_mask  (definitive proof pool is routing
 *      AsicBoost work — the strongest in-band signal available)
 *
 * sha256 legacy rigs — ALL of:
 *   1. mining.configure confirms pool does NOT advertise version-rolling
 *   2. mining.authorize accepted  ("ready")
 *   3. Pool sends at least one mining.notify
 *
 * All other algorithms:
 *   1. mining.authorize accepted  ("ready")
 *   2. Pool sends at least one mining.notify
 */
router.post("/pool/test", requireAuth, async (req, res) => {
  const body = PoolTestBody.parse(req.body);

  logger.info(
    { userId: req.currentUser?.id, poolUrl: body.poolUrl, worker: body.poolWorker },
    "pool:test starting",
  );

  const startMs = Date.now();

  const isAsicboost = body.algorithmSlug === "sha256asicboost";
  const isLegacy = body.algorithmSlug === "sha256";

  const result = await new Promise<{
    success: boolean;
    authFailed: boolean;
    errorMessage: string | null;
    confirmedMask?: string;
  }>((resolve) => {
    const strictConfigure = isAsicboost || isLegacy;
    const upstream = new UpstreamClient(
      body.poolUrl,
      body.poolWorker,
      body.poolPassword,
      0,
      isAsicboost ? DEFAULT_VERSION_ROLLING_MASK : undefined,
      strictConfigure,
    );

    let resolved = false;
    let tcpOk = false;
    let readyReceived = false;
    let notifyReceived = false;
    let versionMask: string | null = null;

    const cleanup = (outcome: {
      success: boolean;
      authFailed: boolean;
      errorMessage: string | null;
      confirmedMask?: string;
    }) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      upstream.destroy();
      resolve(outcome);
    };

    // For sha256asicboost: require ready + notify + versionMask (set_version_mask).
    // For all others:       require ready + notify only.
    const checkDone = () => {
      const notifyOk = readyReceived && notifyReceived;
      if (isAsicboost) {
        if (notifyOk && versionMask !== null) {
          cleanup({ success: true, authFailed: false, errorMessage: null, confirmedMask: versionMask });
        }
      } else {
        if (notifyOk) {
          cleanup({ success: true, authFailed: false, errorMessage: null });
        }
      }
    };

    // 15-second overall deadline.
    const timer = setTimeout(() => {
      let errorMessage: string;
      if (!tcpOk) {
        errorMessage =
          "Could not open a TCP connection to the pool within 15s — pool may be unreachable, the host/port is wrong, or your VPS network is blocking the route";
      } else if (!readyReceived) {
        errorMessage =
          "TCP connected but the pool never replied to mining.subscribe / mining.authorize within 15s — check the worker name format (e.g. NiceHash requires a BTC address as the username)";
      } else if (!notifyReceived) {
        errorMessage =
          "Pool accepted credentials but did not send any mining jobs (mining.notify) — this pool/port may not be routing work for this algorithm";
      } else if (isAsicboost && versionMask === null) {
        // Pool passed configure+auth+jobs but never sent mining.set_version_mask.
        // This means the pool is not confirmed to be actively routing AsicBoost work.
        errorMessage =
          "Pool accepted credentials and sent jobs, but did not confirm AsicBoost routing (no mining.set_version_mask received) — this pool/port may not truly support SHA-256 AsicBoost. Try a dedicated AsicBoost port or a different pool.";
      } else {
        errorMessage = "Pool test timed out";
      }
      cleanup({ success: false, authFailed: false, errorMessage });
    }, 15_000);

    upstream.on("tcpConnected", () => { tcpOk = true; });

    // Definitive proof the pool is actively routing AsicBoost work.
    upstream.on("versionMask", (mask: string) => {
      versionMask = mask;
      checkDone();
    });

    upstream.on("notify", () => {
      notifyReceived = true;
      checkDone();
    });

    upstream.on("ready", () => {
      readyReceived = true;
      checkDone();
    });

    upstream.on("authFailed", () => {
      cleanup({
        success: false,
        authFailed: true,
        errorMessage:
          "Pool rejected the worker credentials — check your worker name and password",
      });
    });

    upstream.on("error", (err: Error) => {
      cleanup({
        success: false,
        authFailed: false,
        errorMessage: err.message ?? "Unknown connection error",
      });
    });

    upstream.connect();
  });

  const latencyMs = result.success ? Date.now() - startMs : null;

  logger.info(
    { poolUrl: body.poolUrl, success: result.success, latencyMs },
    "pool:test complete",
  );

  let successMessage: string;
  if (result.success) {
    if (isAsicboost) {
      successMessage = `Pool confirmed AsicBoost routing (mask: ${result.confirmedMask}) — credentials accepted (${latencyMs}ms)`;
    } else if (isLegacy) {
      successMessage = `Pool confirmed SHA-256 legacy compatibility and is sending work — credentials accepted (${latencyMs}ms)`;
    } else {
      successMessage = `Connected successfully — pool accepted credentials and is sending work (${latencyMs}ms)`;
    }
  } else {
    successMessage = result.errorMessage ?? "Connection failed";
  }

  res.json({
    success: result.success,
    authFailed: result.authFailed,
    latencyMs,
    message: successMessage,
  });
});

export default router;
