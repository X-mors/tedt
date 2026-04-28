import {
  pgTable,
  serial,
  integer,
  text,
  numeric,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { depositAddressesTable } from "./depositAddresses";

export const cryptoDepositsTable = pgTable("crypto_deposits", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .references(() => usersTable.id, { onDelete: "cascade" }),
  depositAddressId: integer("deposit_address_id").references(
    () => depositAddressesTable.id,
    { onDelete: "set null" },
  ),
  currency: text("currency", { enum: ["btc", "usdt_trc20"] }).notNull(),
  amountCrypto: numeric("amount_crypto", { precision: 24, scale: 8 }).notNull(),
  amountUsd: numeric("amount_usd", { precision: 18, scale: 6 }),
  exchangeRate: numeric("exchange_rate", { precision: 18, scale: 6 }),
  txid: text("txid"),
  processorPaymentId: text("processor_payment_id"),
  status: text("status", {
    enum: ["pending", "confirming", "credited", "failed", "unmatched"],
  })
    .notNull()
    .default("pending"),
  confirmations: integer("confirmations").notNull().default(0),
  requiredConfirmations: integer("required_confirmations").notNull().default(1),
  detectedAt: timestamp("detected_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  creditedAt: timestamp("credited_at", { withTimezone: true }),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  processorData: text("processor_data"),
}, (t) => [
  unique("crypto_deposits_processor_payment_id_unique").on(t.processorPaymentId),
]);

export type CryptoDeposit = typeof cryptoDepositsTable.$inferSelect;
export type InsertCryptoDeposit = typeof cryptoDepositsTable.$inferInsert;
