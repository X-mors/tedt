import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  numeric,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { algorithmsTable } from "./algorithms";

export const rigsTable = pgTable("rigs", {
  id: serial("id").primaryKey(),
  ownerId: integer("owner_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  algorithmId: integer("algorithm_id")
    .notNull()
    .references(() => algorithmsTable.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  // Hashrate expressed in the algorithm's unit (e.g. 100 = 100 TH/s).
  hashrate: numeric("hashrate", { precision: 18, scale: 6 }).notNull(),
  minRentalHours: integer("min_rental_hours").notNull().default(1),
  maxRentalHours: integer("max_rental_hours").notNull().default(168),
  region: text("region").notNull().default("Global"),
  status: text("status", { enum: ["available", "rented", "offline", "paused"] })
    .notNull()
    .default("available"),
  approvalStatus: text("approval_status", {
    enum: ["pending", "approved", "rejected"],
  })
    .notNull()
    .default("pending"),
  approvalNote: text("approval_note"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  // Stratum credentials the owner provides — proxy will use these to forward shares.
  stratumHost: text("stratum_host").notNull().default(""),
  stratumPort: integer("stratum_port").notNull().default(0),
  stratumUser: text("stratum_user").notNull().default(""),
  stratumPassword: text("stratum_password").notNull().default("x"),
  // Cryptographically random secret issued at rig creation; used by the proxy to authenticate the miner (legacy format).
  proxyToken: text("proxy_token").notNull().default(""),
  /**
   * The {rigname} portion of the `{stratumUsername}.{rigname}` worker format.
   * Unique per owner. Null for rigs created via the web UI before this feature
   * was introduced (legacy rigs still use proxyToken auth).
   * Auto-populated when a miner first connects with a new rigname.
   */
  stratumName: text("stratum_name"),
  // Set by the Stratum proxy: true while miner TCP session is connected, false on disconnect.
  isOnline: boolean("is_online").notNull().default(false),
  // Set by the Stratum proxy when the miner authenticates.
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("rigs_owner_stratum_name_unique").on(table.ownerId, table.stratumName),
]);

export type Rig = typeof rigsTable.$inferSelect;
export type InsertRig = typeof rigsTable.$inferInsert;
