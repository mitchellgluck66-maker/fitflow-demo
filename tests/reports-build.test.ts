/**
 * Companion stage 3, item 2 — the three builders on the seeded demo tenant (a tenant like any other): a normal
 * period, a partial-data period ("Based on X of Y", a withheld show rate), an empty period; the subject lines;
 * Needs attention first; every figure formatted from the engine.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq, lt } from 'drizzle-orm';
import { runMigrations } from '@/db/migrate';
import { db, appointments } from '@/db';
import { seedDemo, demoUnderRecordedWeek, DEMO_COMPANION_USER } from '@/db/seed-demo';
import { getTimezone } from '@/lib/settings';
import { todayInTimezone } from '@/lib/day';
import { localDate, weekStart, addDays, monthStart, addMonths, monthEnd } from '@/lib/dates';
import { buildReport } from '@/lib/reports/build';
import { periodContaining } from '@/lib/reports/period';

let tz = 'America/Edmonton';
let today = '';
const now = new Date();

beforeAll(async () => {
  await runMigrations();
  await seedDemo();
  tz = await getTimezone();
  today = todayInTimezone(tz, now);
}, 120_000);

describe('daily', () => {
  it('a normal day with Miranda\'s calls: the subject, the totals, the onboarding table, the follow-ups', async () => {
    const past = await db.select({ startTime: appointments.startTime }).from(appointments).where(and(eq(appointments.assignedUserId, DEMO_COMPANION_USER.ghlUserId), lt(appointments.startTime, new Date(now.getTime() - 86_400_000))));
    const day = past.map((r) => localDate(r.startTime, tz)).sort().at(-1)!;
    const r = await buildReport('daily', { start: day, end: day }, { now });
    const m = r.model;
    expect(m.subject).toMatch(/^Daily · \w{3}, \w{3} \d{1,2}, \d{4} · \d+ applied, \d+ consults? booked, \d+ new clients? paid(, \d+ calls? needs? attention)?$/);
    expect(m.empty).toBe(false);
    expect(m.totals.map((c) => c.label)).toEqual(['Applied', 'Enrolled (GHL)', 'Cash collected', 'Calls']);
    expect(m.sections.map((s) => s.title)).toEqual(expect.arrayContaining(['Funnel', 'Money and spend', 'Onboarding', 'Every call']));
    const calls = m.sections.find((s) => s.title === 'Every call');
    expect(calls?.type === 'table' && calls.rows.length).toBeGreaterThan(0);
    expect(m.sections.at(-1)?.title).toMatch(/^Follow-ups for /);
    // Needs attention comes right after the totals in the render.
    expect(r.html.indexOf('Needs attention')).toBeLessThan(r.html.indexOf('Funnel'));
    expect(r.html).toContain('Open the Onboarding page');
    expect(r.text).toContain('NEEDS ATTENTION');
    expect(r.html).not.toContain('undefined');
  });

  it('an empty day (before the demo history): every source says what is missing, `empty` is true', async () => {
    const r = await buildReport('daily', { start: '2026-01-10', end: '2026-01-10' }, { now });
    expect(r.model.empty).toBe(true);
    expect(r.model.subject).toBe('Daily · Sat, Jan 10, 2026 · 0 applied, 0 consults booked, 0 new clients paid');
    expect(r.html).toContain('no spend rows for Sat, Jan 10, 2026');
    expect(r.html).toContain('No onboarding calls on the day.');
  });
});

describe('weekly', () => {
  it('the last complete week: the verdict, the top 3 changes, the gates, the onboarding week', async () => {
    const start = addDays(weekStart(today), -7);
    const r = await buildReport('weekly', periodContaining('weekly', start), { now });
    const m = r.model;
    expect(m.period).toMatchObject({ start, end: addDays(start, 6) });
    expect(m.subject).toMatch(/^Weekly · .+ · ((strong|normal|weak) week: )?\d+ new clients?, \$[\d,]+(\.\d{2})? CAD$/);
    const titles = m.sections.map((s) => s.title);
    expect(titles).toEqual(expect.arrayContaining(['Week verdict', 'Top 3 changes vs last week', 'Money', 'Pipeline', 'Ads', 'Funnel and cost per stage', 'Spend changes allowed / blocked', 'Onboarding week', 'Show rates']));
    const gates = m.sections.find((s) => s.title === 'Spend changes allowed / blocked');
    expect(gates?.type === 'lines' && gates.lines[0]).toMatch(/^Whole account: (may change|HOLD) — /);
    const top = m.sections.find((s) => s.title === 'Top 3 changes vs last week');
    expect(top?.type === 'lines' && top.lines.length).toBeLessThanOrEqual(3);
    expect(r.html).toContain('Open the Scorecard');
  });

  it('the under-recorded week: the withheld consult show rate is a needs-attention line, never a number', async () => {
    const w = demoUnderRecordedWeek(today);
    const r = await buildReport('weekly', w, { now });
    expect(r.model.attention.some((a) => /Consult show rate not shown: attendance recorded for \d+% of consults/.test(a))).toBe(true);
    const rates = r.model.sections.find((s) => s.title === 'Show rates');
    expect(rates?.type === 'table' && rates.rows.find((row) => row[0] === 'Consult')?.[4]).toBe('—');
  });
});

describe('monthly', () => {
  it('last month vs the previous and the 3-month average, best and worst week, partial LTV:CAC named', async () => {
    const start = addMonths(monthStart(today), -1);
    const r = await buildReport('monthly', { start, end: monthEnd(start) }, { now });
    const m = r.model;
    expect(m.subject).toMatch(/^Monthly · \w+ \d{4} · \d+ new clients?, \$[\d,]+(\.\d{2})? CAD vs (\$[\d,]+(\.\d{2})? CAD avg|no 3-month average)$/);
    const cmp = m.sections.find((s) => s.title?.startsWith('This month vs last month'));
    expect(cmp?.type === 'table' && cmp.headers).toEqual(['Metric', expect.any(String), 'Last month', '3-month avg']);
    expect(cmp?.type === 'table' && cmp.rows.map((row) => row[0])).toEqual(['Applied', 'Consults booked', 'Roadmaps booked', 'Enrolled (GHL)', 'New-client cash', 'Cash collected', 'Ad spend', 'Blended CAC', 'Consult show rate', 'Roadmap show rate']);
    const bw = m.sections.find((s) => s.title === 'Best and worst week');
    expect(bw?.type === 'lines' && bw.lines[0]).toMatch(/^Best week — .+ new-client cash · \d+ enrolled/);
    // The partial-data rule travels with the number: LTV:CAC over the valued clients, the rest counted.
    expect(r.html).toMatch(/Based on \d+ of \d+ new clients · \d+ missing contract value/);
    expect(r.html).toContain('Onboarding month');
  });
});
