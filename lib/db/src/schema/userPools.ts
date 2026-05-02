import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * Saved mining pool credentials per user. Both rig owners (for fallback
 * mining) and renters (for active rentals) can save any number of pool
 * profiles here and switch between them from the UI without retyping
 * credentials.
 *
 * Storing pool URLs as full `stratum+tcp://host:port` strings keeps the API
 * surface aligned with the existing rentals.poolUrl format. Owner pools are
 * decomposed into host/port at the call site since the rigs table predates
 * the URL-style storage.
 */
export const userPoolsTable = pgTable(
  "user_pools",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    poolUrl: text("pool_url").notNull(),
    worker: text("worker").notNull(),
    password: text("password").notNull().default("x"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("user_pools_user_label_unique").on(table.userId, table.label),
  ],
);

export type UserPool = typeof userPoolsTable.$inferSelect;
export type InsertUserPool = typeof userPoolsTable.$inferInsert;
