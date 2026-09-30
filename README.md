# FitFlow — Growth Intelligence for The Fit Physician

A **read-only** growth dashboard over GoHighLevel (+ Meta Ads, Google Ads and
Stripe in later phases). It observes the funnel, computes CAC/funnel economics,
and will send scheduled email reports. It never writes to GoHighLevel.

The standing contract is [`CLAUDE.md`](./CLAUDE.md); the plan is
[`docs/FitFlow-v2-Master-Plan.pdf`](./docs/FitFlow-v2-Master-Plan.pdf).

## Quick start (local, no keys needed)

```bash
npm install
npm run db:migrate   # embedded PGlite Postgres in ./db/pglite (no DATABASE_URL needed)
npm run db:seed      # sample data, every row origin='demo'
npm run dev          # http://localhost:3000
```

With a Supabase project, put `DATABASE_URL` in `.env.local` (see `.env.example`)
and the same commands run against Postgres — the CLIs load `.env.local` too, so
`db:seed`, `sync:*` and the app always hit the same database.

## Authentication

The deployed app is public on the internet and holds real client data and
stored API credentials, so **every page and API route requires a session**.
`proxy.ts` (Next 16's request interceptor) redirects unauthenticated pages to
`/login` and answers API calls with `401`. Exempt, each with its own guard:
`/login`, Next static assets, `/api/health`, `/api/cron/*` (`CRON_SECRET`)
and `/api/stripe/webhook` (Stripe signature).

- Set `APP_PASSWORD` (the shared team password) and `AUTH_SECRET`
  (`openssl rand -base64 48`; signs the cookie) in the Vercel project.
  **Production or preview without them fails closed** — a 503 "FitFlow is
  locked" page and no data, on purpose.
- Locally with both unset, auth is skipped so `npm run dev`, tests and the
  screenshot harness work without a password.
- A correct password sets an `httpOnly`, `Secure`, `SameSite=Lax` cookie with
  an HMAC-signed token; sessions last 30 days and slide (re-issued after a day
  of use). Passwords are compared in constant time; `/api/auth/login` allows 5
  attempts per minute per IP. **Sign out** in the nav clears the cookie.
- Rotating `AUTH_SECRET` signs every device out.

## Credentials at rest and the database API

- **`CREDENTIALS_KEY`** (required in production and preview): 32 random bytes,
  `openssl rand -base64 32`, set in Vercel → Settings → Environment Variables.
  Every credential pasted in Setup (GHL, Meta, Stripe, Anthropic, Google Ads)
  is stored AES-256-GCM encrypted with it and decrypted only on the server
  when a request needs it; Setup still shows the same masked previews.
  **Without it, production fails closed**: stored credentials read as absent,
  new ones cannot be saved, and Setup says why. Locally with it unset,
  credentials are stored unencrypted as before.
- After setting the key, run `npm run db:migrate` (or `npm run
  credentials:encrypt`) once against production: it seals every credential
  saved before encryption existed. Then **rotate the GHL, Meta and Stripe
  keys** — the old ones sat in plaintext.
- Keep the key somewhere besides Vercel (a password manager). Losing it means
  re-entering every credential in Setup; changing it does the same.
- **Row-level security**: every table has RLS enabled with no policies
  (migration 0009), so Supabase's public REST API returns nothing even to
  someone holding the anon key. The app connects as the table owner and is
  unaffected.

## Backups (nightly, encrypted)

Supabase's free tier keeps no backups, so `.github/workflows/backup.yml`
`pg_dump`s the database every night (09:15 UTC), encrypts the dump with
AES-256 and keeps it 90 days as a workflow artifact. Restoring:
[`docs/restore-runbook.md`](docs/restore-runbook.md). Configure **two repo
secrets** (GitHub → Settings → Secrets and variables → Actions, or `gh secret
set NAME`):

| Secret | Value |
| --- | --- |
| `DATABASE_URL` | the Supabase **session-pooler** connection string (port 5432 on `*.pooler.supabase.com`) — not the transaction pooler (6543) and not the direct IPv6 host |
| `BACKUP_PASSPHRASE` | a long random passphrase (`openssl rand -base64 48`); keep a copy in the password manager — GitHub never shows it again, and without it the backups cannot be opened |

Then run it once by hand (Actions → Nightly database backup → Run workflow,
or `gh workflow run backup.yml`) and rehearse a restore (runbook section 3).

## Scheduling (Vercel Pro, hourly) and the GitHub fallback

Since 2026-09-30 the app is on Vercel Pro. `vercel.json` runs `GET /api/cron/sync-ghl` every hour at :07 (the
followed pipeline in full, then the weekly mirror pass) and `GET /api/cron/dispatch` every hour at :37 (Stripe,
the Stripe completeness sweep, Meta, reconcile, insights, digests). Vercel sends `Authorization: Bearer
$CRON_SECRET` itself — set `CRON_SECRET` in the Vercel project's environment variables.

`.github/workflows/heartbeat.yml` is a **fallback** every 6 hours: it calls the same two routes with the header
`X-FitFlow-Trigger: github-heartbeat` (up to 290 s each). A non-2xx fails the run (red ✗ under Actions); the log
lists every dispatch step's outcome. Configure **two repo secrets**:

| Secret | Value |
| --- | --- |
| `APP_URL` | the production origin, e.g. `https://fitflow.vercel.app` (no trailing path) |
| `CRON_SECRET` | exactly the value of the Vercel env var `CRON_SECRET` (`openssl rand -hex 32` if you are setting both fresh) |

Every cron call records itself; **no scheduled run for 3 hours** opens a critical `scheduler_silent` incident
and shows a red line in the banner ("No scheduled sync since … — check the Vercel cron jobs"). Setup → Sync
health shows the last run and who made it (vercel / github).

**Actions minutes:** 4 fallback runs a day × ~5 billed minutes ≈ 600 minutes a month, plus the nightly backup
(~90) — well inside GitHub Free's 2,000 for private repos.

## Connecting GoHighLevel (read-only)

1. In GHL: Settings → Private Integrations → create a token with only the
   read scopes listed on the Setup page.
2. Open **/setup**, paste the token + Location ID, **Save & verify**.
3. **Run backfill** (from June 16, 2026) — every imported row is flagged
   `backfilled=true`.
4. Confirm any **unmapped stages** in the stage-role table.
5. **Remove sample data** once real rows are present.

Crons (`CRON_SECRET`-protected): `/api/cron/sync-ghl` (hourly at :07) and `/api/cron/dispatch` (hourly at
:37) from `vercel.json`, with the GitHub Actions fallback every 6 h (above). CLI equivalents:
`npm run sync:now`, `npm run backfill`, `npm run sync:meta`, `npm run sync:stripe`.

Meta Ads and Stripe are connected the same way on **/setup** (token pasted, verified
with one read call, masked). Until then the Ads tab runs on manual weekly spend and the
Revenue tab shows a "Connect Stripe" state — never estimated numbers.

## Stripe webhook (real-time payments between nightly reconciles)

The nightly dispatch reconciles the last 7 days of Stripe activity; the
webhook delivers payments the moment they happen.

1. Stripe Dashboard → **Developers → Webhooks → Add endpoint**.
2. Endpoint URL: `https://<app-url>/api/stripe/webhook`.
3. Events: `charge.succeeded`, `charge.refunded`, `charge.failed`,
   `invoice.payment_succeeded`, `invoice.payment_failed`.
4. Copy the endpoint's **signing secret** (`whsec_…`) into the Vercel project
   as `STRIPE_WEBHOOK_SECRET` (or paste it in Setup → Stripe) and **redeploy**.

Every delivery is signature-verified; unverified requests are rejected with
400. The endpoint is exempt from the login gate for that reason. A payment
that arrives by webhook is classified (initial / recurring) and matched to
its contact immediately; the nightly reconcile heals anything a webhook
missed.

## Ops: what runs when, and what to read

- `/api/cron/dispatch` runs Stripe → Meta → Google → GHL (20 s budget,
  resumable) → reconciliation → incident sweep → insights → narratives →
  digests. Every step is isolated: one source failing or hanging never stops
  the others, and each outcome is its own `sync_runs` row (`dispatch:<step>`
  for steps without a source row).
- **Reconciliation** compares live per-stage open counts in GoHighLevel with
  this mirror for the followed pipeline every night; drift beyond max(2, 10%)
  raises a `reconcile_mismatch` incident and shows in the amber banner and
  Setup → Sync health ("last reconciled … — mirror matches GHL: yes/no").
- **Stale banner**: any connected source (GHL, Meta, Stripe) whose last
  completed sync is older than 26 h is named on every data page with its own
  Sync now button.
- **Incidents**: unmapped-stage incidents auto-resolve when the stage is
  mapped or its pipeline unfollowed; stale silence notices and duplicate
  errors are swept nightly; Setup → Incidents has "Resolve all noise";
  `npm run incidents:sweep` is the one-shot cleanup.

## Demo mode

FitFlow can run on a fabricated but internally consistent dataset for demos.
Every demo row is labelled (`origin='demo'`, AI reports `content.demo=true`,
digests prefixed `[demo]`, sync runs `trigger='demo'`), the **sample-data banner
shows on every analytics page while any demo row exists**, and wiping never
touches real rows.

| Command | What it does |
| --- | --- |
| `npm run db:seed:demo` | Rich story from June 16 → today: ~200 leads across Facebook (two campaigns — one winner, one loser), Google, Referral and Website with UTMs; week-over-week variation; recovered no-shows; ~15 enrollments with Stripe-like payments (2 failed, 1 refund, 3 subscriptions, 2 unmatched); daily campaign spend; 3 pre-generated insight reports + 1 weekly narrative (model `demo`, so the AI card renders without a key); 4 weeks of digest history; sync runs. Idempotent — wipes demo rows first. |
| `npm run db:wipe:demo` | Removes every demo row and confirms the banner is gone. |
| `npm run db:seed` | The small original sample set (kept for quick local checks). |

### Two databases: real vs demo

- **Real** — `DATABASE_URL` in `.env.local` points at the Supabase project. The app
  *and* every CLI (`db:seed:demo`, `db:wipe:demo`, `sync:*`) load `.env.local`, so
  they always target the same database. Running `db:seed:demo` here puts the demo
  story in the live app; `db:wipe:demo` takes it out again before real syncs.
- **Local / embedded** — with `DATABASE_URL` unset (or blank) the app and CLIs use
  the embedded PGlite Postgres in `db/pglite/`. To keep a demo copy separate from
  the real project: `DATABASE_URL= npm run db:seed:demo` then
  `DATABASE_URL= npm run dev`. `PGLITE_DATA_DIR=/some/dir` selects a different
  embedded copy. Tests always use an in-memory PGlite and never touch either.

AI insight cards and email digests in the demo are pre-generated snapshots marked
`demo`; with a real Anthropic / Resend key the nightly job replaces them with live
output and the `[demo]` rows are removed by `db:wipe:demo`.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run check` | typecheck + tests + read-only proof + production build |
| `npm run test` | Vitest (role mapper, transition diffing, read-only guard, full mocked sync on PGlite) |
| `npm run verify:readonly` | grep-based proof that no code path can send a non-GET to GHL |
| `npm run db:generate` | regenerate a Drizzle migration after editing `db/schema.ts` |
| `npm run credentials:encrypt` | seal any plaintext credential rows with `CREDENTIALS_KEY` (also runs after `db:migrate`) |

## Stack

Next.js 16 · TypeScript · Tailwind 4 · Drizzle ORM · Postgres (Supabase / PGlite) ·
Zod at every API boundary · Vitest · Vercel crons.

## Layout

- `db/schema.ts` — pipelines, stages (semantic_role), contacts, appointments,
  stage_transitions, stage_snapshots, ad_spend, payments, email_digests,
  ai_reports, sync_runs, sync_incidents, settings.
- `lib/ghl/` — `client.ts` (read-only), `schemas.ts` (Zod), `roles.ts`
  (stage → role mapper), `transitions.ts` (pure diffing), `ingest.ts` (sync).
  `sync.ts` + `mapping.ts` are the dormant v1 write-back engine.
- `app/api/` — routes; `app/setup` — credentials, sync, stage roles, health.
