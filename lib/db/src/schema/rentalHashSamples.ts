import {
  pgTable,
  serial,
  integer,
  numeric,
  timestamp,
  boolean,
} from "drizzle-orm/pg-core";
import { rentalsTable } from "./rentals";

export const rentalHashSamplesTable = pgTable("rental_hash_samples", {
  id: serial("id").primaryKey(),
  rentalId: integer("rental_id")
    .notNull()
    .references(() => rentalsTable.id, { onDelete: "cascade" }),
  sampledAt: timestamp("sampled_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  windowSeconds: integer("window_seconds").notNull().default(60),
  sharesAccepted: integer("shares_accepted").notNull().default(0),
  sharesRejected: integer("shares_rejected").notNull().default(0),
  difficultySum: numeric("difficulty_sum", { precision: 18, scale: 6 })
    .notNull()
    .default("0"),
  effectiveHashrateH: numeric("effective_hashrate_h", {
    precision: 18,
    scale: 3,
  }),
  poolOffline: boolean("pool_offline").notNull().default(false),
});

export type RentalHashSample = typeof rentalHashSamplesTable.$inferSelect;
export type InsertRentalHashSample =
  typeof rentalHashSamplesTable.$inferInsert;
