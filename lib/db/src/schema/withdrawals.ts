import {
  pgTable,
  serial,
  text,
  integer,
  numeric,
  timestamp,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const withdrawalsTable = pgTable("withdrawals", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  asset: text("asset", { enum: ["BTC", "USDT"] }).notNull(),
  destinationAddress: text("destination_address").notNull(),
  amountUsd: numeric("amount_usd", { precision: 18, scale: 6 }).notNull(),
  status: text("status", {
    enum: ["pending", "approved", "sending", "sent", "confirmed", "rejected"],
  })
    .notNull()
    .default("pending"),
  adminNote: text("admin_note"),
  onChainTxid: text("on_chain_txid"),
  processorPaymentId: text("processor_payment_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
});

export type WithdrawalRow = typeof withdrawalsTable.$inferSelect;
export type InsertWithdrawal = typeof withdrawalsTable.$inferInsert;
