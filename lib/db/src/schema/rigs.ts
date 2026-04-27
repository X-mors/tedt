import {
  pgTable,
  serial,
  text,
  integer,
  numeric,
  timestamp,
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
  status: text("status", { enum: ["available", "rented", "offline"] })
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
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type Rig = typeof rigsTable.$inferSelect;
export type InsertRig = typeof rigsTable.$inferInsert;
