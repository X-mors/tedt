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

const PROXY_DEFAULTS: ProxySettings = {
  lowDeliveryThresholdPct: 0.70,
  lowDeliveryWindowSec: 1800,
  minSharesForCheck: 5,
};

export interface WalletCryptoSettings {
  enabledCurrencies: string[];
  /** Minimum deposit in USD before crediting (BTC) */
  btcMinDepositUsd: number;
  /** Minimum deposit in USD before crediting (USDT TRC-20) */
  usdtTrc20MinDepositUsd: number;
  /** Required on-chain confirmations for BTC */
  btcRequiredConfirmations: number;
  /** Required on-chain confirmations for USDT TRC-20 */
  usdtTrc20RequiredConfirmations: number;
  /** Flat withdrawal fee in USD deducted from BTC payouts */
  btcWithdrawalFeeUsd: number;
  /** Flat withdrawal fee in USD deducted from USDT TRC-20 payouts */
  usdtTrc20WithdrawalFeeUsd: number;
  /** Maximum total withdrawal USD per user per 24h (0 = unlimited) */
  dailyWithdrawalCapUsd: number;
  /** Rate source: "coingecko" (default) or "fixed" */
  rateSource: "coingecko" | "fixed";
  /** Fixed USD price per BTC (only used when rateSource = "fixed") */
  fixedBtcUsd: number;
  /** Fixed USD price per USDT (only used when rateSource = "fixed") */
  fixedUsdtUsd: number;
}

const WALLET_DEFAULTS: WalletCryptoSettings = {
  enabledCurrencies: ["btc", "usdt_trc20"],
  btcMinDepositUsd: 10,
  usdtTrc20MinDepositUsd: 1,
  btcRequiredConfirmations: 2,
  usdtTrc20RequiredConfirmations: 20,
  btcWithdrawalFeeUsd: 0,
  usdtTrc20WithdrawalFeeUsd: 0,
  dailyWithdrawalCapUsd: 0,
  rateSource: "coingecko",
  fixedBtcUsd: 0,
  fixedUsdtUsd: 1,
};

const CACHE_TTL_MS = 60_000;
let proxyCached: ProxySettings | null = null;
let proxyCacheExpiresAt = 0;
let walletCached: WalletCryptoSettings | null = null;
let walletCacheExpiresAt = 0;

function parseNumber(map: Record<string, string>, key: string, def: number): number {
  const v = Number(map[key]);
  return Number.isFinite(v) ? v : def;
}

export async function getProxySettings(): Promise<ProxySettings> {
  if (proxyCached && Date.now() < proxyCacheExpiresAt) return proxyCached;

  const rows = await db
    .select({ key: platformSettingsTable.key, value: platformSettingsTable.value })
    .from(platformSettingsTable);

  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  proxyCached = {
    lowDeliveryThresholdPct: parseNumber(map, "low_delivery_threshold_pct", PROXY_DEFAULTS.lowDeliveryThresholdPct),
    lowDeliveryWindowSec: parseNumber(map, "low_delivery_window_sec", PROXY_DEFAULTS.lowDeliveryWindowSec),
    minSharesForCheck: parseNumber(map, "min_shares_for_check", PROXY_DEFAULTS.minSharesForCheck),
  };
  proxyCacheExpiresAt = Date.now() + CACHE_TTL_MS;
  return proxyCached;
}

export async function getWalletSettings(): Promise<WalletCryptoSettings> {
  if (walletCached && Date.now() < walletCacheExpiresAt) return walletCached;

  const rows = await db
    .select({ key: platformSettingsTable.key, value: platformSettingsTable.value })
    .from(platformSettingsTable);

  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  const rawCurrencies = map["wallet_enabled_currencies"];
  const enabledCurrencies = rawCurrencies
    ? rawCurrencies.split(",").map((s) => s.trim()).filter(Boolean)
    : WALLET_DEFAULTS.enabledCurrencies;

  const rateSourceRaw = map["wallet_rate_source"];
  const rateSource: "coingecko" | "fixed" =
    rateSourceRaw === "fixed" ? "fixed" : "coingecko";

  walletCached = {
    enabledCurrencies,
    btcMinDepositUsd: parseNumber(map, "wallet_btc_min_deposit_usd", WALLET_DEFAULTS.btcMinDepositUsd),
    usdtTrc20MinDepositUsd: parseNumber(map, "wallet_usdt_trc20_min_deposit_usd", WALLET_DEFAULTS.usdtTrc20MinDepositUsd),
    btcRequiredConfirmations: parseNumber(map, "wallet_btc_required_confirmations", WALLET_DEFAULTS.btcRequiredConfirmations),
    usdtTrc20RequiredConfirmations: parseNumber(map, "wallet_usdt_trc20_required_confirmations", WALLET_DEFAULTS.usdtTrc20RequiredConfirmations),
    btcWithdrawalFeeUsd: parseNumber(map, "wallet_btc_withdrawal_fee_usd", WALLET_DEFAULTS.btcWithdrawalFeeUsd),
    usdtTrc20WithdrawalFeeUsd: parseNumber(map, "wallet_usdt_trc20_withdrawal_fee_usd", WALLET_DEFAULTS.usdtTrc20WithdrawalFeeUsd),
    dailyWithdrawalCapUsd: parseNumber(map, "wallet_daily_withdrawal_cap_usd", WALLET_DEFAULTS.dailyWithdrawalCapUsd),
    rateSource,
    fixedBtcUsd: parseNumber(map, "wallet_fixed_btc_usd", WALLET_DEFAULTS.fixedBtcUsd),
    fixedUsdtUsd: parseNumber(map, "wallet_fixed_usdt_usd", WALLET_DEFAULTS.fixedUsdtUsd),
  };
  walletCacheExpiresAt = Date.now() + CACHE_TTL_MS;
  return walletCached;
}

async function setSetting(key: string, value: string): Promise<void> {
  await db
    .insert(platformSettingsTable)
    .values({ key, value })
    .onConflictDoUpdate({
      target: platformSettingsTable.key,
      set: { value, updatedAt: new Date() },
    });
}

export async function setProxySetting(key: string, value: string): Promise<void> {
  await setSetting(key, value);
  proxyCached = null;
  proxyCacheExpiresAt = 0;
}

export async function setWalletSetting(key: string, value: string): Promise<void> {
  await setSetting(key, value);
  walletCached = null;
  walletCacheExpiresAt = 0;
}

export { PROXY_DEFAULTS as proxySettingsDefaults, WALLET_DEFAULTS as walletSettingsDefaults };
