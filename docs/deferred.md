# Deferred: waiting on Mitchell + his boss (as of 2026-09-30)

Don't build or change anything below until Mitchell says so. Each item says what it unblocks.

| # | Item | Who | Unblocks |
|---|---|---|---|
| 1 | **Definition of Applied** (docs/applied-reconciliation-2026-09-20.md §5). The candidate: people who submitted the application form, dated by submission, including form applicants routed to other pipelines. Sep 20–26: 43 vs 52 shown today; Aug: ~130 vs 221. | Boss decision | Engine change, glossary, Analyst definitions |
| 2 | Add the **forms.readonly** scope to the GHL Private Integration token | Boss (GHL admin) | Exact submission times and duplicate submissions |
| 3 | **GHL routing:** "Fit Physician Application (B)" form → Marketing/Sales Pipeline, and an old workflow → "{ Off } Sales Funnel". Sales follow-up for Erin FitzPatrick, Suzan Abdel Salam, Lisa Brinn | Boss / sales team | Every applicant lands in the Application pipeline |
| 4 | **Meta Events Manager:** SubmitApplication ("Congrats2") shows ~2× real applications. Check event count vs deduplicated, and browser vs server events | Boss (Meta admin) | Correct cost per result in Ads Manager |
| 5 | **Offers & Targets** tabs + setup banner (docs/claude-code-prompt-analyst-addendum-offers-targets.md) | Mitchell | CAC payback, LTV:CAC, funnel-leak $, pace to target |
| 6 | **Owner profile:** offer prices, contract value, gross margin, monthly target, target CAC, goals, team/rep names, dated events | Boss | Same as 5, plus by-rep analysis |
| 7 | **Anthropic org:** 30-day data retention (needed for Fable "Deep"), ~$50 API credit | Mitchell/boss | Fable option; eval runs |
| 8 | Link Stripe prices to offers | Boss | Exact average contract value |
| 9 | Weekly Claude reconciliation check (scheduled task) | Mitchell | After the reconciliation job ships |

## Rules while these are deferred

- Show the current definitions honestly. Where a deferred item skews a number, say so on screen
  (a data caveat), and the Analyst states it. Never silently.
- Anything in the Analyst that depends on 5–8 is withheld with the missing field named (plan
  amendment 4).
