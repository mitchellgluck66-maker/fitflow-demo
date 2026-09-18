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

## Connecting GoHighLevel (read-only)

1. In GHL: Settings → Private Integrations → create a token with only the
   read scopes listed on the Setup page.
2. Open **/setup**, paste the token + Location ID, **Save & verify**.
3. **Run backfill** (from June 16, 2026) — every imported row is flagged
   `backfilled=true`.
4. Confirm any **unmapped stages** in the stage-role table.
5. **Remove sample data** once real rows are present.

Vercel crons (`vercel.json`, `CRON_SECRET`-protected): `/api/cron/sync-ghl` hourly and
`/api/cron/dispatch` (GHL → Meta → Stripe → digests) at 11/12 UTC. CLI equivalents:
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
