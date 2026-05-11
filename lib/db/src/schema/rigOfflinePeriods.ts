import { pgTable, serial, integer, timestamp } from "drizzle-orm/pg-core";
import { rigsTable } from "./rigs";

export const rigOfflinePeriodsTable = pgTable("rig_offline_periods", {
  id: serial("id").primaryKey(),
  rigId: integer("rig_id")
    .notNull()
    .references(() => rigsTable.id, { onDelete: "cascade" }),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});

export type RigOfflinePeriod = typeof rigOfflinePeriodsTable.$inferSelect;
export type InsertRigOfflinePeriod = typeof rigOfflinePeriodsTable.$inferInsert;
