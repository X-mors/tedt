import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Key-value store for admin-configurable platform settings.
 * Values are stored as text; callers cast to the appropriate type.
 */
export const platformSettingsTable = pgTable("platform_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .$onUpdate(() => new Date())
    .defaultNow(),
});
