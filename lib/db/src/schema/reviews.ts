import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { rigsTable } from "./rigs";
import { rentalsTable } from "./rentals";

export const reviewsTable = pgTable(
  "reviews",
  {
    id: serial("id").primaryKey(),
    rentalId: integer("rental_id")
      .notNull()
      .references(() => rentalsTable.id, { onDelete: "cascade" }),
    rigId: integer("rig_id")
      .notNull()
      .references(() => rigsTable.id, { onDelete: "cascade" }),
    renterId: integer("renter_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    rating: integer("rating").notNull(),
    body: text("body").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("reviews_rental_unique").on(table.rentalId)],
);

export type Review = typeof reviewsTable.$inferSelect;
export type InsertReview = typeof reviewsTable.$inferInsert;
