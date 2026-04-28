import { eq } from "drizzle-orm";
import { db, platformSettingsTable } from "@workspace/db";

export interface ProxySettings {
  /** Fraction of advertised hashrate below which auto-cancel triggers (0–1) */
  lowDeliveryThresholdPct: number;
  /** Window in seconds over which delivery is measured for auto-cancel */
  lowDeliveryWindowSec: number;
  /** Minimum shares required in the window before auto-cancel can trigger */
  minSharesForCheck: number;
}

const DEFAULTS: ProxySettings = {
  lowDeliveryThresholdPct: 0.70,
  lowDeliveryWindowSec: 1800,
  minSharesForCheck: 5,
};

const CACHE_TTL_MS = 60_000;
let cached: ProxySettings | null = null;
let cacheExpiresAt = 0;

export async function getProxySettings(): Promise<ProxySettings> {
  if (cached && Date.now() < cacheExpiresAt) return cached;

  const rows = await db
    .select({ key: platformSettingsTable.key, value: platformSettingsTable.value })
    .from(platformSettingsTable);

  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  const parse = (key: string, def: number) => {
    const v = Number(map[key]);
    return Number.isFinite(v) ? v : def;
  };

  cached = {
    lowDeliveryThresholdPct: parse(
      "low_delivery_threshold_pct",
      DEFAULTS.lowDeliveryThresholdPct,
    ),
    lowDeliveryWindowSec: parse(
      "low_delivery_window_sec",
      DEFAULTS.lowDeliveryWindowSec,
    ),
    minSharesForCheck: parse(
      "min_shares_for_check",
      DEFAULTS.minSharesForCheck,
    ),
  };
  cacheExpiresAt = Date.now() + CACHE_TTL_MS;
  return cached;
}

export async function setProxySetting(key: string, value: string): Promise<void> {
  await db
    .insert(platformSettingsTable)
    .values({ key, value })
    .onConflictDoUpdate({
      target: platformSettingsTable.key,
      set: { value, updatedAt: new Date() },
    });
  // Invalidate cache
  cached = null;
  cacheExpiresAt = 0;
}

export { DEFAULTS as proxySettingsDefaults };
