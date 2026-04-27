import {
  pgTable,
  serial,
  text,
  numeric,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const algorithmsTable = pgTable(
  "algorithms",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    unit: text("unit").notNull(),
    basePricePerUnitPerHour: numeric("base_price_per_unit_per_hour", {
      precision: 18,
      scale: 8,
    })
      .notNull()
      .default("0"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex("algorithms_slug_unique").on(table.slug)],
);

export type Algorithm = typeof algorithmsTable.$inferSelect;
export type InsertAlgorithm = typeof algorithmsTable.$inferInsert;
