import {
  pgTable,
  serial,
  integer,
  numeric,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { rigsTable } from "./rigs";
import { rentalsTable } from "./rentals";

/**
 * Per-rig hashrate samples. Inserted once per minute by the stratum flush
 * loop for any rig that produced shares in the previous window — whether
 * the rig was serving a rental (rentalId set) or mining to its fallback
 * pool (rentalId null). Owners read this table to display a continuous
 * 14-day hashrate history regardless of rental activity.
 */
export const rigHashSamplesTable = pgTable(
  "rig_hash_samples",
  {
    id: serial("id").primaryKey(),
    rigId: integer("rig_id")
      .notNull()
      .references(() => rigsTable.id, { onDelete: "cascade" }),
    rentalId: integer("rental_id").references(() => rentalsTable.id, {
      onDelete: "set null",
    }),
    sampledAt: timestamp("sampled_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    windowSeconds: integer("window_seconds").notNull().default(60),
    sharesAccepted: integer("shares_accepted").notNull().default(0),
    sharesRejected: integer("shares_rejected").notNull().default(0),
    effectiveHashrateH: numeric("effective_hashrate_h", {
      precision: 18,
      scale: 3,
    }),
  },
  (t) => ({
    rigSampledAtIdx: index("rig_hash_samples_rig_sampled_idx").on(
      t.rigId,
      t.sampledAt,
    ),
  }),
);

export type RigHashSample = typeof rigHashSamplesTable.$inferSelect;
export type InsertRigHashSample = typeof rigHashSamplesTable.$inferInsert;
