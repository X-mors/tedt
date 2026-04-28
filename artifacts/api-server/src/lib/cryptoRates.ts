import { getWalletSettings } from "./platformSettings";
import { logger } from "./logger";

const COINGECKO_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin%2Ctether&vs_currencies=usd";

interface RateCache {
  btcUsd: number;
  usdtUsd: number;
  fetchedAt: number;
}

let cache: RateCache | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function fetchCoingeckoRates(): Promise<{ btcUsd: number; usdtUsd: number }> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return { btcUsd: cache.btcUsd, usdtUsd: cache.usdtUsd };
  }

  try {
    const res = await fetch(COINGECKO_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
    const data = (await res.json()) as {
      bitcoin?: { usd?: number };
      tether?: { usd?: number };
    };
    const btcUsd = data.bitcoin?.usd ?? 0;
    const usdtUsd = data.tether?.usd ?? 1;
    if (btcUsd <= 0) throw new Error("CoinGecko returned zero BTC price");
    cache = { btcUsd, usdtUsd, fetchedAt: now };
    logger.info({ btcUsd, usdtUsd }, "Refreshed crypto rates from CoinGecko");
    return { btcUsd, usdtUsd };
  } catch (err) {
    logger.warn({ err }, "CoinGecko fetch failed — using cached or fallback rates");
    if (cache) return { btcUsd: cache.btcUsd, usdtUsd: cache.usdtUsd };
    return { btcUsd: 0, usdtUsd: 1 };
  }
}

export async function getCryptoRates(): Promise<{
  btcUsd: number;
  usdtUsd: number;
}> {
  const settings = await getWalletSettings();
  if (settings.rateSource === "fixed") {
    return {
      btcUsd: settings.fixedBtcUsd > 0 ? settings.fixedBtcUsd : 0,
      usdtUsd: settings.fixedUsdtUsd > 0 ? settings.fixedUsdtUsd : 1,
    };
  }
  return fetchCoingeckoRates();
}

export async function usdToCrypto(
  amountUsd: number,
  currency: "btc" | "usdt_trc20",
): Promise<number> {
  const rates = await getCryptoRates();
  if (currency === "btc") {
    if (rates.btcUsd <= 0) return 0;
    return amountUsd / rates.btcUsd;
  }
  return amountUsd / rates.usdtUsd;
}

export async function cryptoToUsd(
  amountCrypto: number,
  currency: "btc" | "usdt_trc20",
): Promise<number> {
  const rates = await getCryptoRates();
  if (currency === "btc") return amountCrypto * rates.btcUsd;
  return amountCrypto * rates.usdtUsd;
}
