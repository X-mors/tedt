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
 * Opens a real Stratum connection to the given pool, completes the full
 * mining.subscribe + mining.authorize handshake, AND waits for the pool to
 * send at least one mining.notify (actual work / job).  A pool that accepts
 * credentials but never sends jobs would produce 0 hashrate during a real
 * rental, so we treat "no job within the timeout" as a failure.
 */
router.post("/pool/test", requireAuth, async (req, res) => {
  const body = PoolTestBody.parse(req.body);

  logger.info(
    { userId: req.currentUser?.id, poolUrl: body.poolUrl, worker: body.poolWorker },
    "pool:test starting",
  );

  const startMs = Date.now();

  // Declared here so they are accessible both inside the Promise callback
  // and in the success-message block that runs after the Promise resolves.
  const isAsicboost = body.algorithmSlug === "sha256asicboost";
  const isLegacy = body.algorithmSlug === "sha256";

  const result = await new Promise<{
    success: boolean;
    authFailed: boolean;
    errorMessage: string | null;
  }>((resolve) => {
    // Pair the test with the rig's actual algorithm so the test fails fast
    // if the user pasted a pool URL meant for a different stratum mode
    // (e.g. an AsicBoost rig pointed at a legacy-only port, or vice versa).
    const strictConfigure = isAsicboost || isLegacy;
    const upstream = new UpstreamClient(
      body.poolUrl,
      body.poolWorker,
      body.poolPassword,
      0,
      isAsicboost ? DEFAULT_VERSION_ROLLING_MASK : undefined,
      strictConfigure,
    );

    // Guards against resolving more than once (e.g. timer fires while an
    // event is also arriving).
    let resolved = false;
    let tcpOk = false;
    let readyReceived = false;
    let notifyReceived = false;

    const cleanup = (outcome: {
      success: boolean;
      authFailed: boolean;
      errorMessage: string | null;
    }) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      upstream.destroy();
      resolve(outcome);
    };

    // Success requires TWO conditions:
    //   1. Pool accepted credentials (mining.authorize OK → "ready")
    //   2. Pool sent at least one mining.notify (actual mining job / work)
    // Either can arrive first — pools vary on whether they send work before
    // or after the authorize response.
    const checkDone = () => {
      if (readyReceived && notifyReceived) {
        cleanup({ success: true, authFailed: false, errorMessage: null });
      }
    };

    // 15-second overall deadline. The extra 5 s over the old 10 s gives the
    // pool time to send its first job after a successful authorize.
    const timer = setTimeout(() => {
      const errorMessage = readyReceived
        ? "Pool accepted credentials but did not send any mining work (jobs) within 15s — this pool/port may not actively support this algorithm, or try a different pool URL"
        : tcpOk
        ? "TCP connected but the pool never replied to mining.subscribe / mining.authorize within 15s — usually means the worker name is in the wrong format (e.g. NiceHash requires a BTC address as the username) or the pool silently rejected the credentials"
        : "Could not open a TCP connection to the pool within 15s — pool may be unreachable, the host/port is wrong, or your VPS network is blocking the route";
      cleanup({ success: false, authFailed: false, errorMessage });
    }, 15_000);

    upstream.on("tcpConnected", () => {
      tcpOk = true;
    });

    // Pool sent a mining job — the pool is actively routing work to this worker.
    upstream.on("notify", () => {
      notifyReceived = true;
      checkDone();
    });

    // Pool accepted the worker credentials.
    upstream.on("ready", () => {
      readyReceived = true;
      checkDone();
    });

    upstream.on("authFailed", () => {
      cleanup({
        success: false,
        authFailed: true,
        errorMessage: "Pool rejected the worker credentials — check your worker name and password",
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
      successMessage = `Pool confirmed AsicBoost (version-rolling) support and is sending work — credentials accepted (${latencyMs}ms)`;
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
