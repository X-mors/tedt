import {
  pgTable,
  serial,
  text,
  integer,
  numeric,
  timestamp,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { rentalsTable } from "./rentals";

export const walletTransactionsTable = pgTable("wallet_transactions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  type: text("type", {
    enum: [
      "deposit",
      "withdrawal",
      "rental_charge",
      "rental_payout",
      "rental_refund",
      "rental_dispute",
      "admin_credit",
      "admin_debit",
    ],
  }).notNull(),
  // Signed amount. Positive = credit, negative = debit.
  amountUsd: numeric("amount_usd", { precision: 18, scale: 6 }).notNull(),
  balanceAfterUsd: numeric("balance_after_usd", {
    precision: 18,
    scale: 6,
  }).notNull(),
  memo: text("memo").notNull().default(""),
  relatedRentalId: integer("related_rental_id").references(
    () => rentalsTable.id,
    { onDelete: "set null" },
  ),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type WalletTransaction = typeof walletTransactionsTable.$inferSelect;
export type InsertWalletTransaction =
  typeof walletTransactionsTable.$inferInsert;
