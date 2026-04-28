import crypto from "crypto";
import { logger } from "./logger";

const NP_API_BASE = "https://api.nowpayments.io/v1";

function apiKey(): string {
  const key = process.env["NOWPAYMENTS_API_KEY"];
  if (!key) throw new Error("NOWPAYMENTS_API_KEY is not set");
  return key;
}

async function npFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const url = `${NP_API_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "x-api-key": apiKey(),
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`NOWPayments ${options.method ?? "GET"} ${path} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export interface NpPayment {
  payment_id: string;
  pay_address: string;
  pay_currency: string;
  pay_amount: number;
  price_amount: number;
  price_currency: string;
  payment_status: string;
  actually_paid: number;
  actually_paid_at_fiat: number;
  outcome_amount: number;
  outcome_currency: string;
  expiration_estimate_date: string | null;
  created_at: string;
  updated_at: string;
  payin_extra_id?: string;
}

export interface NpPaymentStatus {
  payment_id: string;
  payment_status: string;
  pay_address: string;
  price_amount: number;
  price_currency: string;
  pay_currency: string;
  pay_amount: number;
  actually_paid: number;
  actually_paid_at_fiat: number;
  outcome_amount: number;
  outcome_currency: string;
  purchase_id: string;
  order_id?: string;
  order_description?: string;
  payin_extra_id?: string;
  smart_contract?: string;
  network?: string;
  network_precision?: string;
  time_limit?: string;
  burning_percent?: string;
  expiration_estimate_date?: string;
  is_fixed_rate: boolean;
  is_fee_paid_by_user: boolean;
  valid_until?: string;
  type?: string;
  updated_at: string;
  created_at: string;
}

export type NpCurrency = "btc" | "usdttrc20";

const CURRENCY_MAP: Record<string, NpCurrency> = {
  btc: "btc",
  usdt_trc20: "usdttrc20",
};

function toNpCurrency(currency: "btc" | "usdt_trc20"): NpCurrency {
  return CURRENCY_MAP[currency] ?? "btc";
}

export async function createDepositPayment(
  currency: "btc" | "usdt_trc20",
  orderId: string,
): Promise<NpPayment> {
  const payCurrency = toNpCurrency(currency);
  const body = {
    price_amount: 1,
    price_currency: "usd",
    pay_currency: payCurrency,
    order_id: orderId,
    order_description: `RigMarket deposit address (${currency.toUpperCase()}) — ${orderId}`,
    is_fixed_rate: false,
    is_fee_paid_by_user: false,
  };
  logger.info({ currency, orderId }, "Creating NOWPayments deposit payment");
  return npFetch<NpPayment>("/payment", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function getPaymentStatus(paymentId: string): Promise<NpPaymentStatus> {
  return npFetch<NpPaymentStatus>(`/payment/${paymentId}`);
}

export interface NpPayoutRequest {
  address: string;
  currency: NpCurrency;
  amount: number;
  ipn_callback_url?: string;
  extra_id?: string;
}

export interface NpPayoutResponse {
  id: string;
  address: string;
  currency: string;
  amount: number;
  status: string;
  batch_withdrawal_id?: string;
  error?: string;
  extra_id?: string;
  hash?: string;
  created_at: string;
  updated_at: string;
}

export async function createPayout(req: NpPayoutRequest): Promise<NpPayoutResponse> {
  logger.info({ address: req.address, currency: req.currency, amount: req.amount }, "Creating NOWPayments payout");
  return npFetch<NpPayoutResponse>("/payout", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function getPayoutStatus(payoutId: string): Promise<NpPayoutResponse> {
  return npFetch<NpPayoutResponse>(`/payout/${payoutId}`);
}

export interface NpWebhookPayload {
  payment_id: string;
  payment_status: string;
  pay_address: string;
  price_amount: number;
  price_currency: string;
  pay_currency: string;
  pay_amount: number;
  actually_paid: number;
  actually_paid_at_fiat: number;
  outcome_amount: number;
  outcome_currency: string;
  order_id?: string;
  order_description?: string;
  purchase_id?: string;
  created_at: string;
  updated_at: string;
}

export function verifyIpnSignature(
  rawBody: string,
  receivedSig: string,
): boolean {
  const secret = process.env["NOWPAYMENTS_IPN_SECRET"];
  if (!secret) {
    logger.error("NOWPAYMENTS_IPN_SECRET not set — rejecting IPN request");
    return false;
  }
  try {
    const sorted = sortedJsonString(rawBody);
    const expected = crypto
      .createHmac("sha512", secret)
      .update(sorted)
      .digest("hex");
    const sigLower = receivedSig.toLowerCase();
    if (sigLower.length !== expected.length) return false;
    return crypto.timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(sigLower, "hex"),
    );
  } catch {
    return false;
  }
}

function sortedJsonString(raw: string): string {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    return JSON.stringify(sortObject(obj));
  } catch {
    return raw;
  }
}

function sortObject(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(sortObject);
  if (obj !== null && typeof obj === "object") {
    return Object.keys(obj as object)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortObject((obj as Record<string, unknown>)[k]);
        return acc;
      }, {});
  }
  return obj;
}

export const nowpaymentsConfigured = (): boolean =>
  Boolean(process.env["NOWPAYMENTS_API_KEY"]);
