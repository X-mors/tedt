import type { Request, Response, NextFunction } from "express";
import { getAuth, clerkClient } from "@clerk/express";
import { eq } from "drizzle-orm";
import { db, usersTable, type User } from "@workspace/db";

declare module "express-serve-static-core" {
  interface Request {
    currentUser?: User;
  }
}

const ADMIN_EMAILS = (process.env["ADMIN_EMAILS"] ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return ADMIN_EMAILS.includes(email.toLowerCase());
}

/**
 * Resolve the local users row for the currently authenticated Clerk user.
 * Creates the row on first sight (idempotent).
 */
export async function ensureUserRecord(req: Request): Promise<User | null> {
  const auth = getAuth(req);
  const clerkUserId = auth?.userId;
  if (!clerkUserId) return null;

  const existing = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.clerkUserId, clerkUserId))
    .limit(1);

  if (existing.length > 0) {
    const user = existing[0]!;
    // Promote to admin on contact if email is in the admin allowlist and not already admin.
    if (user.role !== "admin" && isAdminEmail(user.email)) {
      const [promoted] = await db
        .update(usersTable)
        .set({ role: "admin" })
        .where(eq(usersTable.id, user.id))
        .returning();
      return promoted ?? user;
    }
    return user;
  }

  // Fetch profile from Clerk to populate email + display name.
  let email = "";
  let displayName = "";
  try {
    const clerkUser = await clerkClient.users.getUser(clerkUserId);
    email =
      clerkUser.primaryEmailAddress?.emailAddress ??
      clerkUser.emailAddresses[0]?.emailAddress ??
      "";
    const first = clerkUser.firstName ?? "";
    const last = clerkUser.lastName ?? "";
    const composite = `${first} ${last}`.trim();
    displayName =
      composite ||
      clerkUser.username ||
      email.split("@")[0] ||
      "Miner";
  } catch (err) {
    req.log?.warn({ err }, "Failed to fetch Clerk user profile");
  }

  const role = isAdminEmail(email) ? "admin" : "renter";

  const [created] = await db
    .insert(usersTable)
    .values({
      clerkUserId,
      email,
      displayName,
      role,
    })
    .returning();

  return created ?? null;
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const auth = getAuth(req);
  if (!auth?.userId) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
  const user = await ensureUserRecord(req);
  if (!user) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
  req.currentUser = user;
  next();
}

export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  await requireAuth(req, res, async () => {
    if (req.currentUser?.role !== "admin") {
      res.status(403).json({ error: "Admin only" });
      return;
    }
    next();
  });
}
