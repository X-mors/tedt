import { Router, type IRouter } from "express";
import healthRouter from "./health";
import meRouter from "./me";
import marketplaceRouter from "./marketplace";
import rigsRouter from "./rigs";
import meRigsRouter from "./meRigs";
import rentalsRouter from "./rentals";
import walletRouter from "./wallet";
import adminRouter from "./admin";

const router: IRouter = Router();

router.use(healthRouter);
router.use(meRouter);
router.use(marketplaceRouter);
router.use(rigsRouter);
router.use(meRigsRouter);
router.use(rentalsRouter);
router.use(walletRouter);
router.use(adminRouter);

// Translate Zod validation errors into 400s and other thrown errors into 500s.
router.use((err: unknown, req: import("express").Request, res: import("express").Response, _next: import("express").NextFunction) => {
  if (err && typeof err === "object" && "issues" in err) {
    res.status(400).json({
      error: "Invalid request",
      details: (err as { issues: unknown }).issues,
    });
    return;
  }
  req.log?.error({ err }, "Unhandled API error");
  const message = err instanceof Error ? err.message : "Internal server error";
  res.status(500).json({ error: message });
});

export default router;
