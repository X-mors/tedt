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
});

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

  const result = await new Promise<{
    success: boolean;
    authFailed: boolean;
    errorMessage: string | null;
  }>((resolve) => {
    const upstream = new UpstreamClient(
      body.poolUrl,
      body.poolWorker,
      body.poolPassword,
      0,
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

    const timer = setTimeout(() => {
      cleanup({
        success: false,
        authFailed: false,
        errorMessage: "Connection timed out after 10 seconds — pool may be unreachable or blocked",
      });
    }, 10_000);

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

  res.json({
    success: result.success,
    authFailed: result.authFailed,
    latencyMs,
    message: result.success
      ? `Connected successfully — pool accepted credentials (${latencyMs}ms)`
      : result.errorMessage ?? "Connection failed",
  });
});

export default router;
