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
 * Opens a real Stratum connection to the given pool, runs mining.subscribe
 * and mining.authorize, then immediately disconnects.
 * Returns a structured result so the UI can show the user whether their
 * pool credentials are valid.
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

    const cleanup = (outcome: {
      success: boolean;
      authFailed: boolean;
      errorMessage: string | null;
    }) => {
      clearTimeout(timer);
      upstream.destroy();
      resolve(outcome);
    };

    let tcpOk = false;
    const timer = setTimeout(() => {
      cleanup({
        success: false,
        authFailed: false,
        errorMessage: tcpOk
          ? "TCP connected but the pool never replied to mining.subscribe / mining.authorize within 10s — usually means the worker name is in the wrong format (e.g. NiceHash requires a BTC address as the username, not an account name) or the pool silently rejected the credentials"
          : "Could not open a TCP connection to the pool within 10s — pool may be unreachable, the host/port is wrong, or your VPS network is blocking the route",
      });
    }, 10_000);

    upstream.on("tcpConnected", () => {
      tcpOk = true;
    });

    upstream.on("ready", () => {
      cleanup({ success: true, authFailed: false, errorMessage: null });
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
      successMessage = `Pool confirmed AsicBoost (version-rolling) support — credentials accepted (${latencyMs}ms)`;
    } else if (isLegacy) {
      successMessage = `Pool confirmed SHA-256 legacy compatibility — credentials accepted (${latencyMs}ms)`;
    } else {
      successMessage = `Connected successfully — pool accepted credentials (${latencyMs}ms)`;
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
