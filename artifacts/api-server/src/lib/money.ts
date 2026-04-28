/**
 * Helpers for converting between numeric() database strings and JS numbers.
 * We standardize on USD with 2-decimal display but store with 6-decimal precision.
 */

export function toNum(value: string | number | null | undefined): number {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function toUsdString(value: number): string {
  return round6(value).toFixed(6);
}

/**
 * Canonical delivery-ratio computation used in all settlement paths.
 *
 * Policy (documented in replit.md and settlement.ts header):
 *  - null  → 1.0  Proxy never connected; owner is not penalised for infrastructure gaps.
 *  - 0     → 0.0  Proxy connected but no shares arrived; owner delivered nothing.
 *  - n > 0 → CLIP(delivered / advertised, 0, 1.05)  Proportional, allowing 5 % tolerance.
 */
export function computeDeliveryRatio(
  deliveredHashrateAvg: string | null,
  advertisedHashrate: string,
): number {
  if (deliveredHashrateAvg == null) return 1.0;
  const delivered = toNum(deliveredHashrateAvg);
  const advertised = toNum(advertisedHashrate);
  if (delivered === 0 || advertised === 0) return 0.0;
  return Math.min(1.05, delivered / advertised);
}

/**
 * Returns how many H/s correspond to one "unit" of a given algorithm unit label.
 * Used to convert proxy-computed H/s hashrate into the same scale stored in
 * rigsTable.hashrate (which is always in the algorithm's native unit).
 */
export function unitMultiplier(unit: string): number {
  const lower = unit.toLowerCase();
  if (lower.includes("th")) return 1e12;
  if (lower.includes("gh")) return 1e9;
  if (lower.includes("mh")) return 1e6;
  if (lower.includes("kh")) return 1e3;
  return 1;
}
