import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { rigsTable } from "./rigs";

export const proxyAuthFailuresTable = pgTable("proxy_auth_failures", {
  id: serial("id").primaryKey(),
  rigId: integer("rig_id").references(() => rigsTable.id, { onDelete: "set null" }),
  remoteIp: text("remote_ip").notNull(),
  failureReason: text("failure_reason").notNull(),
  failedAt: timestamp("failed_at", { withTimezone: true }).notNull().defaultNow(),
});
