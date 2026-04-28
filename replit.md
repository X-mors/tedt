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
  approval
- **reviews** — renter feedback on a completed/cancelled rental

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
- Admin: `GET /api/admin/stats`, `GET /api/admin/users`,
  `POST /api/admin/wallet/credit`, `GET|PATCH /api/admin/commission`,
  `POST|PATCH|DELETE /api/admin/algorithms`, withdrawals queue with
  `approve` / `reject`, `GET /api/admin/proxy`,
  `POST /api/admin/proxy/rigs/:rigId/disconnect`
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

## Seeding

`pnpm dlx tsx artifacts/api-server/src/scripts/seed.ts`

Seeds 5 algorithms (SHA-256, Scrypt, Ethash, RandomX, kHeavyHash), the
default 3% / 5% commission row, and 5 demo rigs across two seed owners
(only when those tables are empty).

## Outstanding work (next tasks)

- **Crypto deposit watcher**: `POST /api/me/wallet/deposits` returns a
  generated address; production needs an on-chain watcher (BTC
  full-node/Electrum + USDT TRC-20 RPC) that credits the user's wallet
  on confirmed transfers.

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
