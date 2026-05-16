import { pgTable, serial, integer, timestamp } from "drizzle-orm/pg-core";
import { rentalsTable } from "./rentals";

export const poolOfflinePeriodsTable = pgTable("pool_offline_periods", {
  id: serial("id").primaryKey(),
  rentalId: integer("rental_id")
    .notNull()
    .references(() => rentalsTable.id, { onDelete: "cascade" }),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});

export type PoolOfflinePeriod = typeof poolOfflinePeriodsTable.$inferSelect;
export type InsertPoolOfflinePeriod = typeof poolOfflinePeriodsTable.$inferInsert;
