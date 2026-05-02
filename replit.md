# RigMarket

A mining-rig rental marketplace (in the spirit of MiningRigRentals): the site
operator (admin) lists algorithms and commission rates, hardware owners list
rigs, and renters pay an internal USD balance — funded by BTC / USDT crypto
deposits — to point hashpower at their own pools. Site collects two-sided
commissions (renter + owner) on every rental.

## Stack

- **Monorepo**: pnpm workspaces, Node 24, TypeScript 5.9
- **API**: Express 5 + Drizzle ORM + PostgreSQL, built with esbuild
- **API contract**: OpenAPI -> Orval codegen -> shared Zod schemas
  (`@workspace/api-zod`) and React Query hooks (`@workspace/api-client-react`)
- **Auth**: Clerk (`@clerk/express` server, `@clerk/react` + `@clerk/themes`
  client)
- **Frontend**: React 19 + Vite + Tailwind v4 + shadcn/ui + framer-motion +
  wouter + TanStack Query, JetBrains Mono + Inter

## Artifacts

- `artifacts/api-server` — Express API on `/api/*`
- `artifacts/rigmarket` — public web app
- `artifacts/mockup-sandbox` — design preview server (template default)

## Domain model

`lib/db/src/schema/`

- **users** — Clerk-mirrored users with role (`admin` | `owner` | `renter`)
  and a USD wallet balance + lifetime totals
- **algorithms** — `name`, `slug`, `unit` (e.g. TH/s, MH/s), and the *base*
  `pricePerUnitPerHour` set by the admin
- **commissionConfig** — singleton row holding `renterFeePct` (added on top
  of base) and `ownerFeePct` (subtracted from base before paying owner)
- **rigs** — owner-listed hardware: algorithm, hashrate, min/max rental
  hours, region, status (`available` | `rented` | `offline`) and the owner's
  upstream Stratum (host/port/user/password) used by the proxy
- **rentals** — immutable price snapshot (hashrate × hours × base × fees)
  plus generated proxy credentials (`stratumProxyUrl`, `proxyWorker`,
  `proxyPassword`), timestamps, and `deliveredHashrateAvg` updated in real
  time by the Stratum proxy
- **rentalHashSamples** — 60-second hashrate snapshots flushed by the proxy:
  `sharesAccepted`, `sharesRejected`, `difficultySum`, `effectiveHashrateH`
- **walletTransactions** — append-only ledger
  (`deposit | withdrawal | rental_charge | rental_refund | rental_payout |
  admin_credit | admin_debit`)
- **withdrawals** — user-requested payout (BTC / USDT) requiring admin
  approval; extended with `onChainTxid`, `processorPaymentId`, `sentAt`;
  statuses: `pending | approved | sending | sent | confirmed | rejected`
  (`sending` is a transient lock preventing double-payout races)
- **depositAddresses** — one BTC + one USDT-TRC20 address per user,
  generated via NOWPayments and cached forever (table has unique per userId+currency)
- **cryptoDeposits** — per-payment deposit row tracked by the deposit worker
  and IPN webhook; statuses: `pending | confirming | credited | failed | unmatched`
- **reviews** — renter feedback on a completed/completed rental

## Pricing math

For a rental of `H` hashrate units for `T` hours of an algorithm with base
price `P`:

- `subtotal = H × P × T`
- Renter pays `subtotal × (1 + renterFeePct/100)`
- Owner earns `subtotal × (1 − ownerFeePct/100)`
- Site keeps `subtotal × (renterFeePct + ownerFeePct) / 100`

Cancellations prorate by elapsed time, refund the renter and pay the owner
their prorated earnings.

**Delivery-based settlement (Task #2):** When a rental expires, settlement
uses the actual hashrate measured by the Stratum proxy:

- `delivery_ratio = CLIP(deliveredHashrateAvg / advertisedHashrate, 0, 1.05)`
- `ownerPayout = ownerEarningsUsd × delivery_ratio`
- `renterRefund = renterTotalUsd × (1 − delivery_ratio)`
- If no hash data (proxy never connected), ratio defaults to 1.0 — full
  payout to owner.

Auto-cancel: if average hashrate over a 30-minute window falls below 70% of
the advertised value (and at least 5 shares have been seen), the rental is
cancelled with a prorated refund.

## Crypto Wallet Integration

Deposits and withdrawals use [NOWPayments](https://nowpayments.io/) as the
payment processor. Price feeds use [CoinGecko](https://coingecko.com/) (public
API, no key required) or admin-configurable fixed rates.

**Deposit flow:**
1. User requests deposit addresses via `GET /api/me/wallet/deposit-addresses`
2. Server creates a NOWPayments payment per currency (BTC / USDT-TRC20) with
   `confirmation_required` set from admin config; the resulting `pay_address`
   is cached in `depositAddresses`
3. NOWPayments sends IPN events to `POST /api/wallet/webhook/nowpayments`
   (HMAC-verified with `NOWPAYMENTS_IPN_SECRET`); the deposit worker also polls
   every 60 s as a fallback
4. On `finished` status: deposit is credited atomically to user balance +
   `walletTransactions` ledger (idempotent via `processorPaymentId` unique key)

**Withdrawal flow:**
1. User requests withdrawal via `POST /api/me/wallet/withdrawals`
2. Admin approves (`POST /admin/withdrawals/:id/approve`) or rejects
3. Admin marks sent (`POST /admin/withdrawals/:id/mark-sent`) — this
   atomically transitions `pending|approved → sending` (distributed lock
   preventing double-payout), calls NOWPayments payout API, then sets `sent`
4. Admin confirms (`POST /admin/withdrawals/:id/confirm`) transitions `sent → confirmed`
5. On rejection, user balance is refunded atomically

**Secrets required:**
- `NOWPAYMENTS_API_KEY` — NOWPayments v1 API key (from account.nowpayments.io/api-keys)
- `NOWPAYMENTS_IPN_SECRET` — IPN HMAC secret (from NOWPayments account → IPN settings)

If either secret is absent, the server logs a warning at startup and crypto
functions return `ready: false` to the client.

## Stratum Proxy

The in-process Stratum v1 TCP proxy runs on `STRATUM_PORT` (default 3333).

Architecture: each rig owner's miner connects with `rig-{id}` as the
Stratum worker and the rig's secret token as password (SHA-256 of
`rig-{id}-{createdAt.toISOString()}`). When an active rental exists the
proxy opens a connection to the renter's `poolUrl` and routes all traffic
bidirectionally. Shares are tracked per-rental (difficulty × 2^32 / time =
H/s) and flushed to `rental_hash_samples` every 60 seconds.

Admin can see all connected rigs and force-disconnect them from the admin
dashboard → "Stratum Proxy" tab.

## API surface (selected)

- `GET /api/marketplace/summary`, `GET /api/algorithms`
- `GET /api/rigs`, `GET /api/rigs/:id`, `GET /api/rigs/:id/reviews`
- `GET|POST /api/me/rigs`, `PATCH|DELETE /api/me/rigs/:id`
- `POST /api/rentals/quote`, `POST /api/rentals`, `GET /api/rentals/:id`,
  `GET /api/rentals/:id/stats` (live proxy data), `POST /api/rentals/:id/cancel`,
  `POST /api/rentals/:id/review`
- `GET /api/me/rentals`, `GET /api/me/rentals/lessor`
- `GET /api/me/wallet`, `POST /api/me/wallet/deposits`,
  `GET|POST /api/me/wallet/withdrawals`
- Wallet crypto: `GET /api/me/wallet/deposit-addresses`,
  `GET /api/me/wallet/deposits`
- IPN webhooks: `POST /api/wallet/webhook/nowpayments` (deposit IPN, HMAC-verified),
  `POST /api/wallet/webhook/nowpayments/payout` (payout/withdrawal confirmation IPN)
- Admin: `GET /api/admin/stats`, `GET /api/admin/users`,
  `POST /api/admin/wallet/credit`, `GET|PATCH /api/admin/commission`,
  `POST|PATCH|DELETE /api/admin/algorithms`, withdrawals queue with
  `approve` / `mark-sent` / `confirm` / `reject`,
  `GET /api/admin/deposits/unmatched`,
  `POST /api/admin/withdrawals/:id/mark-sent`,
  `POST /api/admin/withdrawals/:id/confirm`,
  `GET|PUT /api/admin/wallet/settings`,
  `GET /api/admin/proxy`, `POST /api/admin/proxy/rigs/:rigId/disconnect`
- `GET /api/me`, `PATCH /api/me`, `POST /api/me/sync`

## Environment variables

- `DATABASE_URL` (required, provisioned)
- `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`,
  `VITE_CLERK_PUBLISHABLE_KEY` (required)
- `ADMIN_EMAILS` (optional, comma-separated allowlist; users with a
  matching Clerk primary email are auto-promoted to `admin` on sync)
- `STRATUM_PORT` (optional, default 3333) — TCP port for the Stratum proxy
- `STRATUM_PROXY_HOST` (optional, default `proxy.rigmarket.dev`) — shown to
  rig owners as the proxy URL
- `NOWPAYMENTS_API_KEY` (secret, required for crypto deposits) — NOWPayments
  v1 API key; get from <https://account.nowpayments.io/api-keys>
- `NOWPAYMENTS_IPN_SECRET` (secret, required for IPN verification) — the
  IPN secret configured in your NOWPayments account settings

## Seeding

`pnpm dlx tsx artifacts/api-server/src/scripts/seed.ts`

Seeds 5 algorithms (SHA-256, Scrypt, Ethash, RandomX, kHeavyHash), the
default 3% / 5% commission row, and 5 demo rigs across two seed owners
(only when those tables are empty).

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks
  and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally
- `pnpm dlx tsx artifacts/api-server/src/scripts/seed.ts` — seed demo data

See the `pnpm-workspace` skill for workspace structure, TypeScript setup,
and package details.

## VPS Deploy Commands (USER PREFERENCE — ALWAYS PRINT)

After **every** code fix or edit, ALWAYS print this exact block at the end of
the response so the user can copy-paste it onto the VPS after pushing to GitHub:

```bash
cd /var/www/livehashrate.com
git pull
pnpm --filter @workspace/api-server run build
pm2 restart tedt-api
```

Notes:
- VPS path: `/var/www/livehashrate.com`, PM2 process name: `tedt-api`.
- Print this block even for frontend-only changes — the user prefers a single
  consistent snippet. If the change touches the frontend (`artifacts/rigmarket`)
  AND the user explicitly asks about frontend deploy, additionally mention:
  `PORT=3000 BASE_PATH=/ pnpm --filter @workspace/rigmarket run build`.
- Do NOT add `pnpm install` or `pnpm --filter @workspace/db run push` unless
  dependencies or DB schema actually changed in this session.
