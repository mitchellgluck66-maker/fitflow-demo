import { NextRequest, NextResponse } from 'next/server';
import { and, eq, gte, lte } from 'drizzle-orm';
import { db, appliedLedger } from '@/db';
import { apiErrorResponse } from '@/lib/dbTimeout';
import { getTimezone } from '@/lib/settings';
import { todayInTimezone } from '@/lib/day';
import { weekEnd, weekStart } from '@/lib/dates';
import { lastCompleteWeek, readAppliedSummary, runAppliedLedger, summarizeWeek, type LedgerRowInput } from '@/lib/reconcile/appliedLedger';
import { ratioRows, readRatioSummary, runAppliedRatio } from '@/lib/reconcile/appliedRatio';
import { APPLICATION_CLASSES, CLASS_LABELS } from '@/lib/reconcile/applied';
import { APPLIED_DEFINITIONS, CANDIDATE_LABEL, CURRENT_LABEL, DEFINITION_UNDER_REVIEW_NOTE, LEDGER_VERSION } from '@/lib/reconcile/definitions';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * GET /api/reconciliation?week=<sunday> — the Applied ledger for one Sun–Sat week (both definitions, the
 * people behind each class, names only) and the Meta ratio per campaign. Reports under the current
 * definition; the candidate column is labelled "candidate — deferred #1, not in use".
 */
export async function GET(request: NextRequest) {
  try {
    const timezone = await getTimezone();
    const today = todayInTimezone(timezone);
    const requested = request.nextUrl.searchParams.get('week');
    const week = requested && /^\d{4}-\d{2}-\d{2}$/.test(requested) ? { start: weekStart(requested), end: weekEnd(weekStart(requested)), label: '' } : lastCompleteWeek(today);
    week.label = `${week.start} – ${week.end}`;
    const [summary, ratio, rows] = await Promise.all([
      readAppliedSummary(),
      readRatioSummary(),
      db.select().from(appliedLedger).where(and(gte(appliedLedger.ledgerOn, week.start), lte(appliedLedger.ledgerOn, week.end))),
    ]);
    const weekSummary = summarizeWeek(rows as unknown as LedgerRowInput[], week);
    const byClass = Object.fromEntries(
      APPLICATION_CLASSES.map((cls) => [
        cls,
        {
          label: CLASS_LABELS[cls],
          count: weekSummary.byClass[cls].count,
          unverified: weekSummary.byClass[cls].unverified ?? 0,
          /** Rows of this class the engine counts / the candidate would count (from the stored verdicts, never a class rule). */
          currentCount: rows.filter((r) => r.class === cls && r.verdictCurrent).length,
          candidateCount: rows.filter((r) => r.class === cls && r.verdictCandidate).length,
          candidateWouldCount: cls === 'unresolved' ? null : APPLIED_DEFINITIONS.candidate.counts(cls),
          people: rows
            .filter((r) => r.class === cls)
            .sort((a, b) => a.ledgerOn.localeCompare(b.ledgerOn) || a.name.localeCompare(b.name))
            .map((r) => ({ name: r.name, on: r.ledgerOn, reason: r.reason, pipeline: r.pipelineName, contactId: r.contactId, link: r.contactId ? `/clients/${r.contactId}` : null, alsoInFollowed: r.alsoInFollowed, contactDateUnverified: r.contactCreatedEqualsOpportunity && cls === 'A1' })),
        },
      ]),
    );
    return NextResponse.json({
      today,
      timezone,
      summary,
      ledger: {
        week: { start: week.start, end: week.end, label: week.label, isLastComplete: week.start === lastCompleteWeek(today).start },
        canStepForward: weekEnd(week.start) < lastCompleteWeek(today).end,
        byClass,
        current: weekSummary.current,
        currentLabel: CURRENT_LABEL,
        candidate: weekSummary.candidate,
        candidateLabel: CANDIDATE_LABEL,
        otherPipelines: rows.filter((r) => r.class === 'X').length,
        unresolved: weekSummary.unresolved,
        sampleExcluded: summary?.sampleExcluded ?? 0,
        mirrorAsOf: summary?.mirrorAsOf ?? null,
        trackedAsOf: summary?.trackedAsOf ?? null,
        ranAt: summary?.ranAt ?? null,
        stale: summary ? summary.through !== today : true,
        error: summary?.error ?? null,
        ledgerVersion: LEDGER_VERSION,
        definitionUnderReview: true,
        note: DEFINITION_UNDER_REVIEW_NOTE,
      },
      ratio: ratio ? { ...ratio, campaigns: await ratioRows(7), businessTz: timezone } : null,
    });
  } catch (error) {
    return apiErrorResponse(error, 'Failed to read the reconciliation');
  }
}

/** POST — "Reconcile now": the ledger then the ratio, forced, in this request. */
export async function POST() {
  try {
    const ledger = await runAppliedLedger({ trigger: 'manual', force: true });
    const ratio = ledger.ok ? await runAppliedRatio({ trigger: 'manual', force: true }) : null;
    const ok = ledger.ok && (ratio === null || ratio.ok || Boolean(ratio.notConfigured) || Boolean(ratio.skipped));
    return NextResponse.json(
      {
        ok,
        ledger: { ok: ledger.ok, skipped: ledger.skipped ?? null, reason: ledger.reason ?? ledger.error ?? null },
        ratio: ratio ? { ok: ratio.ok, notConfigured: Boolean(ratio.notConfigured), skipped: ratio.skipped ?? null, partial: Boolean(ratio.partial), reason: ratio.reason ?? ratio.error ?? null } : null,
      },
      { status: ok ? 200 : 500 },
    );
  } catch (error) {
    return NextResponse.json({ ok: false, error: `Reconcile failed: ${error instanceof Error ? error.message : String(error)}` }, { status: 500 });
  }
}
