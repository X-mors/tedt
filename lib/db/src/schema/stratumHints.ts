import { pgTable, integer, text, timestamp, primaryKey } from "drizzle-orm/pg-core";
import { rigsTable } from "./rigs";

export const stratumExtranonceHintsTable = pgTable("stratum_extranonce_hints", {
  rigId: integer("rig_id")
    .primaryKey()
    .references(() => rigsTable.id, { onDelete: "cascade" }),
  extranonce1: text("extranonce1").notNull(),
  e2size: integer("e2size").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const stratumIpRigMappingsTable = pgTable(
  "stratum_ip_rig_mappings",
  {
    ipPort: text("ip_port").notNull(),
    rigId: integer("rig_id")
      .notNull()
      .references(() => rigsTable.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.ipPort, t.rigId] })],
);
