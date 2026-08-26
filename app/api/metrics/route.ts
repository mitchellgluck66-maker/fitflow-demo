import { NextRequest, NextResponse } from 'next/server';
import { db, appointments, contacts, stages, pipelines, stageTransitions } from '@/db';
import { and, gte, lte, eq, asc } from 'drizzle-orm';
import { getTimezone } from '@/lib/settings';
import { getDayBounds, todayInTimezone, addDays } from '@/lib/day';
import { FUNNEL_ROLE_ORDER, ROLE_LABELS } from '@/lib/ghl/roles';

export const dynamic = 'force-dynamic';

/**
 * Analytics for the v1 Metrics tab, computed over the v2 schema.
 *
 * Outcomes are READ from GoHighLevel's appointmentStatus (showed / noshow /
 * cancelled) — nobody marks them here. Definitions:
 *   decided   = showed + noShow          (cancelled and not-yet-recorded excluded)
 *   show rate = showed / decided
 *
 * NOTE: this is an interim endpoint. Phase B replaces it with the pure
 * metrics engine in lib/metrics/ (Sun–Sat weeks, comparison periods).
 */

interface Bucket {
  date: string;
  label: string;
  total: number;
  showed: number;
  noShow: number;
  cancelled: number;
  showRate: number | null;
}

export async function GET(request: NextRequest) {
  try {
    const timezone = await getTimezone();
    const days = Number(request.nextUrl.searchParams.get('days') ?? 30);
    const today = todayInTimezone(timezone);
    const rangeStart = addDays(today, -(days - 1));

    const { startMs } = getDayBounds(rangeStart, timezone);
    const { endMs } = getDayBounds(today, timezone);

    const rows = await db
      .select({
        id: appointments.id,
        startTime: appointments.startTime,
        type: appointments.type,
        outcome: appointments.outcome,
        assignedTo: appointments.assignedTo,
        source: contacts.attributionSource,
        owner: contacts.ownerName,
      })
      .from(appointments)
      .leftJoin(contacts, eq(appointments.contactId, contacts.id))
      .where(and(gte(appointments.startTime, new Date(startMs)), lte(appointments.startTime, new Date(endMs))));

    const allContacts = await db
      .select({
        id: contacts.id,
        source: contacts.attributionSource,
        stageId: contacts.stageId,
        stageName: stages.name,
        role: stages.semanticRole,
        value: contacts.monetaryValueCents,
      })
      .from(contacts)
      .leftJoin(stages, eq(contacts.stageId, stages.id));

    const pct = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 100) : 0);
    const localDate = (d: Date) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

    interface Tally {
      total: number;
      showed: number;
      noShow: number;
      cancelled: number;
    }
    const emptyTally = (): Tally => ({ total: 0, showed: 0, noShow: 0, cancelled: 0 });
    const addTo = (t: Tally, outcome: string | null) => {
      t.total += 1;
      if (outcome === 'showed') t.showed += 1;
      else if (outcome === 'no_show') t.noShow += 1;
      else if (outcome === 'cancelled') t.cancelled += 1;
    };
    const derive = (t: Tally) => {
      const decided = t.showed + t.noShow;
      return {
        ...t,
        decided,
        marked: decided,
        unmarked: t.total - decided - t.cancelled,
        showRate: pct(t.showed, decided),
        noShowRate: pct(t.noShow, decided),
      };
    };

    // ---- 1. Daily trend ---------------------------------------------------
    const byDay = new Map<string, Tally>();
    for (let i = 0; i < days; i += 1) byDay.set(addDays(rangeStart, i), emptyTally());
    for (const row of rows) {
      const bucket = byDay.get(localDate(row.startTime));
      if (bucket) addTo(bucket, row.outcome);
    }
    const trend: Bucket[] = Array.from(byDay.entries()).map(([date, tally]) => {
      const d = derive(tally);
      const [y, m, dd] = date.split('-').map(Number);
      return {
        date,
        label: new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(
          new Date(Date.UTC(y, m - 1, dd, 12)),
        ),
        total: d.total,
        showed: d.showed,
        noShow: d.noShow,
        cancelled: d.cancelled,
        // null on days with nothing decided: "no data", not "0% show rate".
        showRate: d.decided > 0 ? d.showRate : null,
      };
    });

    // ---- 2. Weekly rollup (chunks of 7 from range start — Phase B replaces with Sun–Sat) ----
    const weekly: Array<{ label: string; showed: number; noShow: number; cancelled: number; showRate: number }> = [];
    for (let i = 0; i < trend.length; i += 7) {
      const chunk = trend.slice(i, i + 7);
      const t: Tally = {
        total: chunk.reduce((s, c) => s + c.total, 0),
        showed: chunk.reduce((s, c) => s + c.showed, 0),
        noShow: chunk.reduce((s, c) => s + c.noShow, 0),
        cancelled: chunk.reduce((s, c) => s + c.cancelled, 0),
      };
      const d = derive(t);
      weekly.push({
        label: `${chunk[0].label} – ${chunk[chunk.length - 1].label}`,
        showed: d.showed,
        noShow: d.noShow,
        cancelled: d.cancelled,
        showRate: d.showRate,
      });
    }

    // ---- 3. Source / type / owner ------------------------------------------
    const groupBy = (key: (r: (typeof rows)[number]) => string) => {
      const m = new Map<string, Tally>();
      for (const row of rows) {
        const k = key(row);
        if (!m.has(k)) m.set(k, emptyTally());
        addTo(m.get(k)!, row.outcome);
      }
      return m;
    };
    const sourcePerformance = Array.from(groupBy((r) => r.source ?? 'Unknown').entries())
      .map(([source, t]) => ({ source, ...derive(t) }))
      .sort((a, b) => b.total - a.total);
    const typePerformance = Array.from(groupBy((r) => r.type).entries())
      .map(([type, t]) => ({ type, ...derive(t) }))
      .sort((a, b) => b.total - a.total);
    const ownerPerformance = Array.from(groupBy((r) => r.assignedTo ?? r.owner ?? 'Unassigned').entries())
      .map(([owner, t]) => ({ owner, ...derive(t) }))
      .sort((a, b) => b.showRate - a.showRate);

    const leadsBySource = new Map<string, number>();
    for (const c of allContacts) leadsBySource.set(c.source ?? 'Unknown', (leadsBySource.get(c.source ?? 'Unknown') ?? 0) + 1);
    const sourceVolume = Array.from(leadsBySource.entries())
      .map(([source, count]) => ({ source, count, share: pct(count, allContacts.length) }))
      .sort((a, b) => b.count - a.count);

    // ---- 4. Funnel by semantic role (dynamic stages) -----------------------
    const funnel = FUNNEL_ROLE_ORDER.map((role) => {
      const inRole = allContacts.filter((c) => c.role === role);
      return {
        role,
        stage: ROLE_LABELS[role],
        count: inRole.length,
        value: inRole.reduce((s, c) => s + (c.value ?? 0), 0),
      };
    });
    // Current count per actual stage (whatever it is called this month).
    const stageRows = await db
      .select({ id: stages.id, name: stages.name, role: stages.semanticRole, pipeline: pipelines.name })
      .from(stages)
      .innerJoin(pipelines, eq(stages.pipelineId, pipelines.id))
      .orderBy(asc(pipelines.position), asc(stages.position));
    const stageCounts = stageRows.map((s) => ({
      stageId: s.id,
      stage: s.name,
      pipeline: s.pipeline,
      role: s.role,
      count: allContacts.filter((c) => c.stageId === s.id).length,
    }));

    // ---- 5. Headline totals + half-window comparison -----------------------
    const overall = derive(rows.reduce((acc, r) => (addTo(acc, r.outcome), acc), emptyTally()));
    const half = Math.floor(trend.length / 2);
    const sum = (list: Bucket[], key: 'total' | 'showed' | 'noShow' | 'cancelled') => list.reduce((s, b) => s + b[key], 0);
    const tallyOf = (list: Bucket[]) =>
      derive({ total: sum(list, 'total'), showed: sum(list, 'showed'), noShow: sum(list, 'noShow'), cancelled: sum(list, 'cancelled') });
    const recent = tallyOf(trend.slice(half));
    const earlier = tallyOf(trend.slice(0, half));

    // ---- 6. Activity: stage moves in the window -----------------------------
    const moves = await db
      .select({ toRole: stageTransitions.toRole, kind: stageTransitions.kind })
      .from(stageTransitions)
      .where(and(gte(stageTransitions.observedAt, new Date(startMs)), lte(stageTransitions.observedAt, new Date(endMs))));
    const activityCounts = new Map<string, number>();
    for (const m of moves) {
      const k = m.toRole ? `Moved to ${ROLE_LABELS[m.toRole]}` : 'Moved to unmapped stage';
      activityCounts.set(k, (activityCounts.get(k) ?? 0) + 1);
    }

    return NextResponse.json({
      range: { days, start: rangeStart, end: today, timezone },
      overall,
      comparison: {
        showRate: recent.showRate - earlier.showRate,
        noShowRate: recent.noShowRate - earlier.noShowRate,
        volume: recent.total - earlier.total,
      },
      trend,
      weekly,
      sourcePerformance,
      sourceVolume,
      typePerformance,
      ownerPerformance,
      funnel,
      stageCounts,
      totalLeads: allContacts.length,
      totalPipelineValue: allContacts.reduce((s, c) => s + (c.value ?? 0), 0),
      activity: Array.from(activityCounts.entries())
        .map(([action, count]) => ({ action, count }))
        .sort((a, b) => b.count - a.count),
    });
  } catch (error) {
    console.error('Failed to compute metrics:', error);
    return NextResponse.json({ error: 'Failed to compute metrics', detail: String(error) }, { status: 500 });
  }
}
