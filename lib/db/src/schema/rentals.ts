import {
  pgTable,
  serial,
  text,
  integer,
  numeric,
  timestamp,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { rigsTable } from "./rigs";

export const rentalsTable = pgTable("rentals", {
  id: serial("id").primaryKey(),
  rigId: integer("rig_id")
    .notNull()
    .references(() => rigsTable.id, { onDelete: "restrict" }),
  renterId: integer("renter_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "restrict" }),
  ownerId: integer("owner_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "restrict" }),
  hours: integer("hours").notNull(),
  // Snapshots captured at order time so later config changes don't rewrite history.
  hashrate: numeric("hashrate", { precision: 18, scale: 6 }).notNull(),
  basePricePerUnitPerHour: numeric("base_price_per_unit_per_hour", {
    precision: 18,
    scale: 8,
  }).notNull(),
  renterFeePct: numeric("renter_fee_pct", { precision: 6, scale: 3 }).notNull(),
  ownerFeePct: numeric("owner_fee_pct", { precision: 6, scale: 3 }).notNull(),
  renterTotalUsd: numeric("renter_total_usd", { precision: 18, scale: 6 })
    .notNull(),
  ownerEarningsUsd: numeric("owner_earnings_usd", { precision: 18, scale: 6 })
    .notNull(),
  platformFeeUsd: numeric("platform_fee_usd", { precision: 18, scale: 6 })
    .notNull(),
  status: text("status", {
    // "disputed" — cancelled by renter while delivered hashrate was below the
    // 95% threshold. Funds are frozen on both sides until an admin resolves.
    enum: ["pending", "active", "completed", "cancelled", "disputed"],
  })
    .notNull()
    .default("active"),
  // Pool destination chosen by the renter — the proxy will forward shares to it.
  poolUrl: text("pool_url").notNull(),
  poolWorker: text("pool_worker").notNull(),
  poolPassword: text("pool_password").notNull().default("x"),
  // Proxy credentials handed back to the renter to point the rig at.
  stratumProxyUrl: text("stratum_proxy_url").notNull(),
  proxyWorker: text("proxy_worker").notNull(),
  proxyPassword: text("proxy_password").notNull().default("x"),
  startedAt: timestamp("started_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  settledAt: timestamp("settled_at", { withTimezone: true }),
  deliveredHashrateAvg: numeric("delivered_hashrate_avg", {
    precision: 18,
    scale: 6,
  }),
  // Amount frozen pending admin resolution. Set at dispute creation and used
  // by resolve-dispute so the two steps are always consistent regardless of
  // any later changes to deliveredHashrateAvg (e.g. from post-cancel flush).
  frozenUsd: numeric("frozen_usd", { precision: 18, scale: 6 })
    .notNull()
    .default("0"),
  // Cumulative share counters persisted across server restarts so the renter's
  // live UI doesn't reset to 0 on deploys. Updated on each flush by adding
  // the delta from the in-memory rolling window.
  sharesAccepted: integer("shares_accepted").notNull().default(0),
  sharesRejected: integer("shares_rejected").notNull().default(0),
  lastShareAt: timestamp("last_share_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Rental = typeof rentalsTable.$inferSelect;
export type InsertRental = typeof rentalsTable.$inferInsert;
