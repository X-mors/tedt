import {
  pgTable,
  serial,
  text,
  numeric,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const usersTable = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    clerkUserId: text("clerk_user_id").notNull(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    role: text("role", { enum: ["admin", "owner", "renter"] })
      .notNull()
      .default("renter"),
    balanceUsd: numeric("balance_usd", { precision: 18, scale: 6 })
      .notNull()
      .default("0"),
    totalDepositedUsd: numeric("total_deposited_usd", {
      precision: 18,
      scale: 6,
    })
      .notNull()
      .default("0"),
    totalEarnedUsd: numeric("total_earned_usd", { precision: 18, scale: 6 })
      .notNull()
      .default("0"),
    totalSpentUsd: numeric("total_spent_usd", { precision: 18, scale: 6 })
      .notNull()
      .default("0"),
    /**
     * User-chosen Stratum username (the prefix in `username.rigname` worker format).
     * Lowercase letters, digits, hyphens, 3–24 chars. Unique across all users.
     * Null until the user sets one on their profile page.
     */
    stratumUsername: text("stratum_username"),
    /**
     * Shared secret used by the Stratum proxy to authenticate the user.
     * Generated on first view of the profile page; can be regenerated via
     * POST /me/stratum-token/reset (invalidates all current rig connections).
     */
    stratumToken: text("stratum_token"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("users_clerk_user_id_unique").on(table.clerkUserId),
    uniqueIndex("users_stratum_username_unique").on(table.stratumUsername),
  ],
);

export type User = typeof usersTable.$inferSelect;
export type InsertUser = typeof usersTable.$inferInsert;
