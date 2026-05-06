import {
  pgTable,
  serial,
  numeric,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";

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
  deliveryThresholdPct: numeric("delivery_threshold_pct", { precision: 5, scale: 2 })
    .notNull()
    .default("95"),
  rigOfflineTerminateMins: integer("rig_offline_terminate_mins")
    .notNull()
    .default(30),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type CommissionConfigRow = typeof commissionConfigTable.$inferSelect;
