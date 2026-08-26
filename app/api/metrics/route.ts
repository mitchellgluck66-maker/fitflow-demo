import { NextRequest, NextResponse } from 'next/server';
import { db, appointments, leads, leadEvents } from '@/db';
import { and, gte, lte, eq } from 'drizzle-orm';
import { getTimezone } from '@/lib/settings';
import { getDayBounds, todayInTimezone, addDays } from '@/lib/day';

export const dynamic = 'force-dynamic';

/**
 * Analytics for the Metrics tab.
 *
 * Everything is computed from the appointment outcome record rather than the
 * lead's current stage, because stage is a snapshot ("where are they now")
 * while outcomes are the event history ("what actually happened"). Only the
 * latter can answer "which source rebooks best".
 *
 * Definitions used throughout:
 *   attended   = booked + not_continuing  (they turned up)
 *   show rate  = attended / marked
 *   rebook rate = booked / attended       (of those who showed, who continued)
 *
 * Rebook rate is deliberately measured against *attended* rather than all
 * appointments - mixing no-shows into the denominator conflates two different
 * problems (getting people to turn up vs. converting them once they do).
 */

interface Bucket {
  date: string;
  label: string;
  total: number;
  booked: number;
  noShow: number;
  notContinuing: number;
  attended: number;
  showRate: number | null;
  rebookRate: number | null;
}

export async function GET(request: NextRequest) {
  try {
    const timezone = await getTimezone();
    const days = Number(request.nextUrl.searchParams.get('days') ?? 30);
    const today = todayInTimezone(timezone);
    const rangeStart = addDays(today, -(days - 1));

    const { startIso } = getDayBounds(rangeStart, timezone);
    const { endIso } = getDayBounds(today, timezone);

    const rows = await db
      .select({
        id: appointments.id,
        startTime: appointments.startTime,
        type: appointments.type,
        outcome: appointments.outcome,
        assignedTo: appointments.assignedTo,
        leadId: appointments.leadId,
        source: leads.source,
        stage: leads.stage,
        owner: leads.owner,
        estimatedValue: leads.estimatedValue,
        utmCampaign: leads.utmCampaign,
        entryFunnel: leads.entryFunnel,
      })
      .from(appointments)
      .innerJoin(leads, eq(appointments.leadId, leads.id))
      .where(
        and(gte(appointments.startTime, startIso), lte(appointments.startTime, endIso)),
      );

    const allLeads = await db.select().from(leads);

    // ---- Helpers ---------------------------------------------------------
    const pct = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 100) : 0);

    const localDate = (iso: string) =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(iso));

    interface Tally {
      total: number;
      booked: number;
      noShow: number;
      notContinuing: number;
    }
    const emptyTally = (): Tally => ({ total: 0, booked: 0, noShow: 0, notContinuing: 0 });

    const addTo = (tally: Tally, outcome: string | null) => {
      tally.total += 1;
      if (outcome === 'booked') tally.booked += 1;
      else if (outcome === 'no_show') tally.noShow += 1;
      else if (outcome === 'not_continuing') tally.notContinuing += 1;
    };

    const derive = (t: Tally) => {
      const marked = t.booked + t.noShow + t.notContinuing;
      const attended = t.booked + t.notContinuing;
      return {
        ...t,
        marked,
        attended,
        unmarked: t.total - marked,
        showRate: pct(attended, marked),
        // Of the people who showed up, how many booked the next step.
        rebookRate: pct(t.booked, attended),
        noShowRate: pct(t.noShow, marked),
      };
    };

    // ---- 1. Daily trend --------------------------------------------------
    const byDay = new Map<string, Tally>();
    for (let i = 0; i < days; i += 1) {
      byDay.set(addDays(rangeStart, i), emptyTally());
    }

    for (const row of rows) {
      const key = localDate(row.startTime);
      const bucket = byDay.get(key);
      if (bucket) addTo(bucket, row.outcome);
    }

    const trend: Bucket[] = Array.from(byDay.entries()).map(([date, tally]) => {
      const d = derive(tally);
      const [y, m, dd] = date.split('-').map(Number);
      return {
        date,
        label: new Intl.DateTimeFormat('en-US', {
          timeZone: 'UTC',
          month: 'short',
          day: 'numeric',
        }).format(new Date(Date.UTC(y, m - 1, dd, 12))),
        total: d.total,
        booked: d.booked,
        noShow: d.noShow,
        notContinuing: d.notContinuing,
        attended: d.attended,
        // null rather than 0 on days with nothing marked. A closed Sunday is
        // "no data", not "a 0% show rate" - plotting it as zero drags the line
        // to the floor and makes the chart unreadable.
        showRate: d.marked > 0 ? d.showRate : null,
        rebookRate: d.attended > 0 ? d.rebookRate : null,
      };
    });

    // ---- 2. Weekly rollup (smoother signal than daily) -------------------
    const weekly: Array<{ label: string; booked: number; noShow: number; notContinuing: number; showRate: number; rebookRate: number }> = [];
    for (let i = 0; i < trend.length; i += 7) {
      const chunk = trend.slice(i, i + 7);
      if (chunk.length === 0) continue;

      const t: Tally = {
        total: chunk.reduce((s, c) => s + c.total, 0),
        booked: chunk.reduce((s, c) => s + c.booked, 0),
        noShow: chunk.reduce((s, c) => s + c.noShow, 0),
        notContinuing: chunk.reduce((s, c) => s + c.notContinuing, 0),
      };
      const d = derive(t);

      weekly.push({
        label: `${chunk[0].label} – ${chunk[chunk.length - 1].label}`,
        booked: d.booked,
        noShow: d.noShow,
        notContinuing: d.notContinuing,
        showRate: d.showRate,
        rebookRate: d.rebookRate,
      });
    }

    // ---- 3. Lead source performance -------------------------------------
    // Volume tells you where leads come from; rebook rate tells you which of
    // those sources actually produce people who continue. They rarely agree,
    // which is the whole point of showing both.
    const bySource = new Map<string, Tally>();
    for (const row of rows) {
      const key = row.source ?? 'Unknown';
      if (!bySource.has(key)) bySource.set(key, emptyTally());
      addTo(bySource.get(key)!, row.outcome);
    }

    const sourcePerformance = Array.from(bySource.entries())
      .map(([source, tally]) => ({ source, ...derive(tally) }))
      .sort((a, b) => b.total - a.total);

    // Lead volume by source across the whole database, not just this window.
    const leadsBySource = new Map<string, number>();
    for (const lead of allLeads) {
      const key = lead.source ?? 'Unknown';
      leadsBySource.set(key, (leadsBySource.get(key) ?? 0) + 1);
    }
    const sourceVolume = Array.from(leadsBySource.entries())
      .map(([source, count]) => ({
        source,
        count,
        share: pct(count, allLeads.length),
      }))
      .sort((a, b) => b.count - a.count);

    // ---- 4. Appointment type effectiveness ------------------------------
    const byType = new Map<string, Tally>();
    for (const row of rows) {
      if (!byType.has(row.type)) byType.set(row.type, emptyTally());
      addTo(byType.get(row.type)!, row.outcome);
    }
    const typePerformance = Array.from(byType.entries())
      .map(([type, tally]) => ({ type, ...derive(tally) }))
      .sort((a, b) => b.total - a.total);

    // ---- 5. Owner / rep performance -------------------------------------
    const byOwner = new Map<string, Tally>();
    for (const row of rows) {
      const key = row.assignedTo ?? row.owner ?? 'Unassigned';
      if (!byOwner.has(key)) byOwner.set(key, emptyTally());
      addTo(byOwner.get(key)!, row.outcome);
    }
    const ownerPerformance = Array.from(byOwner.entries())
      .map(([owner, tally]) => ({ owner, ...derive(tally) }))
      .sort((a, b) => b.rebookRate - a.rebookRate);

    // ---- 6. Pipeline funnel ---------------------------------------------
    const STAGE_ORDER = [
      'Applied',
      'Consult Booked',
      'Consult No Show',
      'Pre-Roadmap Booked',
      'Roadmap No Show',
      'Roadmap Completed: Objection',
      'Enrolled',
    ];

    const stageCounts = new Map<string, number>();
    for (const lead of allLeads) {
      stageCounts.set(lead.stage, (stageCounts.get(lead.stage) ?? 0) + 1);
    }

    const funnel = STAGE_ORDER.map((stage) => ({
      stage,
      count: stageCounts.get(stage) ?? 0,
      value: allLeads
        .filter((l) => l.stage === stage)
        .reduce((s, l) => s + (l.estimatedValue ?? 0), 0),
    }));

    // ---- 7. Headline totals ---------------------------------------------
    const overall = derive(
      rows.reduce((acc, row) => {
        addTo(acc, row.outcome);
        return acc;
      }, emptyTally()),
    );

    // Compare the most recent half of the window against the earlier half so
    // the KPI tiles can show direction, not just a static number.
    const half = Math.floor(trend.length / 2);
    const sum = (list: Bucket[], key: keyof Bucket) =>
      list.reduce((s, b) => s + ((b[key] as number) ?? 0), 0);

    const recent = trend.slice(half);
    const earlier = trend.slice(0, half);

    const recentTally = derive({
      total: sum(recent, 'total'),
      booked: sum(recent, 'booked'),
      noShow: sum(recent, 'noShow'),
      notContinuing: sum(recent, 'notContinuing'),
    });
    const earlierTally = derive({
      total: sum(earlier, 'total'),
      booked: sum(earlier, 'booked'),
      noShow: sum(earlier, 'noShow'),
      notContinuing: sum(earlier, 'notContinuing'),
    });

    const delta = (now: number, before: number) => now - before;

    // ---- 8. Recent activity ---------------------------------------------
    const events = await db
      .select()
      .from(leadEvents)
      .orderBy(leadEvents.createdAt)
      .limit(400);

    const actionCounts = new Map<string, number>();
    for (const e of events) {
      actionCounts.set(e.action, (actionCounts.get(e.action) ?? 0) + 1);
    }

    return NextResponse.json({
      range: { days, start: rangeStart, end: today, timezone },
      overall,
      comparison: {
        showRate: delta(recentTally.showRate, earlierTally.showRate),
        rebookRate: delta(recentTally.rebookRate, earlierTally.rebookRate),
        noShowRate: delta(recentTally.noShowRate, earlierTally.noShowRate),
        volume: delta(recentTally.total, earlierTally.total),
      },
      trend,
      weekly,
      sourcePerformance,
      sourceVolume,
      typePerformance,
      ownerPerformance,
      funnel,
      totalLeads: allLeads.length,
      totalPipelineValue: allLeads.reduce((s, l) => s + (l.estimatedValue ?? 0), 0),
      activity: Array.from(actionCounts.entries())
        .map(([action, count]) => ({ action, count }))
        .sort((a, b) => b.count - a.count),
    });
  } catch (error) {
    console.error('Failed to compute metrics:', error);
    return NextResponse.json(
      { error: 'Failed to compute metrics', detail: String(error) },
      { status: 500 },
    );
  }
}
