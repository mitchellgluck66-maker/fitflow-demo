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
