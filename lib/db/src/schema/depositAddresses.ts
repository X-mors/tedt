import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const depositAddressesTable = pgTable("deposit_addresses", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  currency: text("currency", { enum: ["btc", "usdt_trc20"] }).notNull(),
  address: text("address").notNull(),
  processorPaymentId: text("processor_payment_id"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type DepositAddress = typeof depositAddressesTable.$inferSelect;
export type InsertDepositAddress = typeof depositAddressesTable.$inferInsert;
