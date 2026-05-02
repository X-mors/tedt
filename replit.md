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
- **userPools** — per-user saved mining-pool credential profiles
  (`label`, `poolUrl`, `worker`, `password`); reusable as one-click prefill
  for new rentals, the in-rental "switch pool" dialog, and rig fallback
  settings. Inline `SaveAsPoolButton` (in
  `artifacts/rigmarket/src/components/save-as-pool-button.tsx`) lets the
  user save the currently-typed pool credentials into their list from any
  of those three forms without leaving the page. Live-switch endpoint
  `POST /rentals/:id/switch-pool` updates the rental row and triggers a
  clean miner reconnect (ASIC firmwares often reject mid-session
  `set_extranonce`, so reconnect is the safest portable behavior). Owner
  telemetry endpoint `GET /me/rigs/:id/live` exposes per-rig hashrate /
  shares for the lessor dashboard.

  **Privacy:** the renter's destination pool credentials
  (`poolUrl/poolWorker/poolPassword`) are renter-only secrets. `GET
  /rentals/:id` redacts them to empty strings for any caller that isn't
  the renter (owner / admin still see all stats but no credentials), and
  the React `RentalCockpit` page hides the entire "Destination Pool"
  card + Switch button for non-renters via `useGetMe()` comparison.

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

### Shadow rigs & online status (DO NOT REMOVE)

When a miner connects with a `stratumName` that doesn't match a listed rig,
the proxy auto-creates a "shadow rig" with a different ID. This means the
miner is connected (and possibly mining via fallback pool), but the
**listed rig** in the marketplace would show OFFLINE if we only marked the
connected `rigId` online.

Two safeguards exist and **must stay in place**:
1. The 5-minute online-sync interval in `index.ts` calls
   `proxyState.getConnectedOwnerIds()` and marks **every approved rig** for
   each connected owner as `isOnline=true`. This covers the shadow-rig case.
2. `selectMyRigDetail` in `meRigs.ts` reads `fallbackPoolConnected` /
   `fallbackPoolAuthFailed` via
   `getFallbackPoolStatus(rigId) ?? getFallbackPoolStatusByOwner(ownerId)`
   so the owner-side UI sees the real upstream pool status even when the
   miner is on a shadow rig.

### Parked upstream eviction on pool change (DO NOT REMOVE)

`_startUpstream` reuses any **parked** upstream pool socket via
`proxyState.claimParkedUpstream(rentalId)` — that's how a 1-3 s natural
miner reconnect doesn't disrupt mining. The 60 s park lives in
`proxyState.parkedUpstreams`.

This means **any code path that changes the rental's destination pool
MUST also evict the parked upstream**, otherwise the miner reconnects,
claims the parked OLD-pool upstream, and silently keeps mining to the
previous pool — DB and UI show "saved" but the renter sees stats stuck
at the OLD-pool's rate. Three places call `removeParkedUpstream`:

1. `DownstreamSession.switchRentalPool` — covers the live-session case.
2. `POST /rentals/:id/switch-pool` route — covers the rig-temporarily-disconnected
   case (no live session to call switchRentalPool on).
3. `removeShareWindow` (already there, on rental settle) — covers cleanup.

Similarly, `reloadFallbackPool` must `_close()` the miner (not just
swap upstreams) because most ASIC firmwares ignore mid-session
`mining.set_extranonce`. Without the close, the owner sees "saved" but
shares get rejected by the new pool.

### Rolling-buffer share tracking (DO NOT REVERT)

`ShareWindow` is **not** flush-and-reset. Each rental keeps a rolling buffer of
the last ~5 minutes of shares (`recentSamples: ShareSample[]`, capped at 2000)
and `getLiveStats` computes effective hashrate from a 2-min lookback over that
buffer. The 60-second DB sample writer (`flushSnapshot`) reads the buffer
without mutating it.

The previous flush-and-reset design caused the user-reported "stats freeze
without affecting mining" bug — for ~30 s after every minute and for the
entire next minute when an ASIC reconnect coincided with the reset, the live
window was empty and the UI showed 0 H/s while mining continued normally.

The owner side has two extra safeguards for the same reason:
1. `lastSeenRigEntries` keeps the rig entry for 10 min after disconnect; the
   `/me/rigs/:id/live` endpoint reads via `getRigEntryWithGrace` so a normal
   ASIC reconnect doesn't flap the UI to OFFLINE / 0 shares.
2. `fallbackWindows` is a per-rig rolling buffer of shares submitted in
   fallback mode (no rental). Without this, idle owner mining always showed
   0 H/s because share counters lived only in the (rentalless) entry.

Renter-side `/rentals/:id/stats` and `/live` use a 3-tier fallback chain when
the live buffer is empty: live → most-recent **non-zero** DB sample (NOT an
average — averaging silent periods sank the display to 0) → cumulative
`deliveredHashrateAvg`. `SOFT_CONNECT_GRACE_MS = 15 min`.

A periodic GC (`_gcSweep`, every 5 min) prunes expired snapshots and idle
fallback buffers; `forgetRig(rigId)` is called on rig delete.

**Optimistic share recording (downstream truth, DO NOT REVERT).** `_handleSubmit`
records the share in the rolling buffer the moment the miner submits it, BEFORE
awaiting the upstream pool's reply. The pool reply can lag seconds or never
arrive (mining.submit timeout = 30 s in `upstream._request`); waiting for it
meant a healthy ASIC's shares trickled into the buffer late or not at all,
producing the user-reported "6 shares in 10 minutes for a rig the pool says is
hashing fine" / "stats start dropping" symptom. `recordShare` /
`recordFallbackShare` return an immutable `RecordedShare` handle (sample,
rigId, rentalId, appended) captured at record time; if the pool actually
rejects, we call the unified `markShareRejected(handle)` which mutates the
original sample in place even if mode/rental flipped during the await.
Real-world reject rate is <1 %, so the optimistic bias is negligible.

The **same pattern applies in the upstream-disconnected branch** of
`_handleSubmit` (when `!this.upstream`): we record optimistically AT BUFFER
TIME and store the `RecordedShare` on the `BufferedSubmit`. Without this the
rolling buffer received zero new samples during pool blips and the live
hashrate decayed to 0 within ~2 min even though the miner was still hashing
— the user-reported "stats appear then stop updating" symptom. On replay,
`_flushSubmitBuffer` does NOT call `recordShare` again (would double-count);
it only calls `markShareRejected(buf.handle)` if the pool ultimately rejects.
Buffer-clear sites (`activateRental`, `switchRentalPool`, `deactivateRental`)
go through `_clearSubmitBuffer()` which sweeps `markShareRejected` over every
pending handle so optimistic credits don't leak when context fundamentally
changes.

### PATCH /me/rigs/:id (DO NOT REMOVE)

The endpoint uses `safeParse` (NOT `.parse()`) for both request body and
response. There is no global Zod error handler — `.parse()` would throw
a 500. `safeParse` returns 400 with field-level details so the frontend
can surface "Update Failed: ..." to the owner.

When `body.fallbackPoolHost === ""` (clearing the pool), the route also
resets `stratumPort = 0` so `hasFallbackPool` (computed as
`!!(stratumHost && stratumPort > 0)`) flips to `false`.

Both safeguards have been silently dropped by checkpoint rollbacks before
(commit `cde5c45 Restored to 027ed1c1...` wiped `b11b58d`/`7550f7d`/
`b0d5ce7`); re-verify after any rollback.

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
NODE_ENV=production pnpm --filter @workspace/rigmarket run build
pm2 restart tedt-api
```

Notes:
- VPS path: `/var/www/livehashrate.com`, PM2 process name: `tedt-api`.
- The rigmarket build is included by default because skipping it has caused
  user-visible regressions (saved-pool dropdowns missing, stats UI mismatch
  with API). If a session truly only touches `artifacts/api-server` you may
  drop the rigmarket build line — but when in doubt, build both.
- Do NOT add `pnpm install` or `pnpm --filter @workspace/db run push` unless
  dependencies or DB schema actually changed in this session.
