import {
  pgTable,
  serial,
  numeric,
  timestamp,
} from "drizzle-orm/pg-core";

// Singleton row (id = 1) holding marketplace commission percentages.
export const commissionConfigTable = pgTable("commission_config", {
  id: serial("id").primaryKey(),
  renterFeePct: numeric("renter_fee_pct", { precision: 6, scale: 3 })
    .notNull()
    .default("3"),
  ownerFeePct: numeric("owner_fee_pct", { precision: 6, scale: 3 })
    .notNull()
    .default("5"),
  cancellationFeePct: numeric("cancellation_fee_pct", { precision: 6, scale: 3 })
    .notNull()
    .default("0"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type CommissionConfigRow = typeof commissionConfigTable.$inferSelect;
