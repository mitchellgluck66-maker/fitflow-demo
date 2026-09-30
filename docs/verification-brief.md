# FitFlow — Full Data Verification Brief (handoff to a fresh session)

Read this, then CLAUDE.md (metric definitions + phase log), then
docs/audit-2026-09-29.md. Goal: prove every number FitFlow shows is correct,
current, and matches its source. Output a pass/fail sheet; every metric
computed twice (independently + by the app) and matched to its source.

## Fixed facts
- Supabase project: `wgddugwyfawzxuugjook` (name "fitflow")
- Tracked funnel pipeline: `[new] Application Pipeline`, id `UR5P3vNTm9VPuYZFrb6c`
  (stage roles for Consult Reschedule / Roadmap Reschedule / Previous Leads /
  Roadmap No Show were set manually 2026-09-17 — role_source='manual')
- Meta ad account: act_204679322688936 · Meta history window from 2026-07-16
- GHL/Stripe backfill window from 2026-06-01
- Weeks are Sun–Sat, business timezone America/Edmonton
- Reporting currency: CAD by default, business-wide CAD|USD toggle; payments
  are mixed CAD/USD, Meta spend is USD; conversion at read time via fx_rates
- Stage history before 2026-09-01 is partial (GHL keeps last stage only):
  consults/roadmaps booked, per-stage costs, stage conversion % for windows
  touching pre-Sept-1 dates are floors — maturing badge sunsets 2026-10-15

## Baseline from the 2026-09-17 spot check (pre-currency-fix, USD-summed)
Jul 16 → Sep 17: spend $24,073.88 (1,075 ad-level rows, 12 campaigns) ·
enrollments 15 (6 paid / 9 organic) · initial cash $54,110 (paid-attributed
$32,025) · contract value $94,000 across the 15. Re-derive under the
currency model; expect cash/value figures to move, spend and counts not.

## Verification plan
1. FRESHNESS: latest successful run per source/family; appointments no
   longer frozen at 2026-09-17; reconcile has executed at least once;
   open incidents are all actionable.
2. INDEPENDENT RECOMPUTE (raw SQL, never lib/metrics) for (a) last full
   Sun–Sat week, (b) last calendar month, (c) Jul 16 → today, in CAD and
   USD: spend, initial cash (paid vs all), enrollments (paid/organic),
   Paid CAC, Blended CAC, ROAS (paid-only), LTV:CAC, cost per lead/
   consult/roadmap/client, consult + roadmap show rates, cohort funnel
   and in-period funnel counts, campaign table, excluded-payment totals.
3. APP SIDE: the same numbers from the app's own engine/API for the same
   ranges. Diff to the cent/count; trace every mismatch to rows.
4. SOURCE SIDE: from Mitchell's Mac (DB + provider APIs reachable there):
   Stripe charge counts/sums per window, Meta insights spend per window,
   GHL per-stage open counts on the tracked pipeline — vs our mirror.
   Also run the in-app Health Check and confirm it agrees (verify the
   verifier).
5. INTEGRITY: dupes, orphans, currency on every money row, no unconverted
   sums, payment_class never null, RLS enabled on all tables, credentials
   encrypted (no plaintext pit-/EAA/rk_ values in settings).
6. Deliver docs/verification-<date>.md: pass/fail per metric per range,
   every discrepancy with root cause and fix.
