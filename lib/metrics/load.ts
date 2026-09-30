/**
 * Row loader for the metrics engine. This is the ONLY place the engine's
 * inputs touch the database. It fetches everything needed for a window (the
 * selected range, its comparison range and the trailing baseline), converts
 * instants to business-local calendar dates, and hands plain rows to the pure
 * functions in ./index.ts.
 */

import { and, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { toStage, fromStage, toStageJoin, fromStageJoin, resolvedToRole, resolvedFromRole } from './transitionRoles';
import { db, contacts, stages, pipelines, stageTransitions, appointments, adSpend, payments, ghlOpportunities } from '@/db';
import { localDate, rangeToInstants } from '../dates';
import { parseCurrency, type Currency } from '../money';
import { loadMoneyContext } from '../money/store';
import type { InputHealth, MetricsInput, PaymentRow, SpendRow } from './index';

export interface LoadOptions {
  /** Widest calendar window needed (YYYY-MM-DD, inclusive). */
  start: string;
  end: string;
  timezone: string;
  /** Restrict to one pipeline; undefined = every tracked pipeline. */
  pipelineId?: string;
}

function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export async function loadMetricsInput(opts: LoadOptions): Promise<MetricsInput> {
  const { start, end } = rangeToInstants({ start: opts.start, end: opts.end }, opts.timezone);
  const tz = opts.timezone;

  // Tracked pipelines (or the one requested).
  const tracked = await db
    .select({ id: pipelines.id })
    .from(pipelines)
    .where(
      opts.pipelineId
        ? eq(pipelines.id, opts.pipelineId)
        : and(eq(pipelines.isTracked, true), isNull(pipelines.archivedAt)),
    );
  const pipelineIds = tracked.map((p) => p.id);

  // Contacts: every contact in a followed pipeline. A contact with no opportunity in ANY pipeline is not an
  // applicant (audit P1 #2, 2026-09-30: 123 such rows came from the appointments sync — check-ins and
  // calls — and a sync can never give them an application). Since F14 dates "applied" by the opportunity,
  // a contact without one has nothing to count anyway; it stays reachable on /clients and in payments.
  const contactRows = await db
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      email: contacts.email,
      source: contacts.attributionSource,
      stageId: contacts.stageId,
      stageName: stages.name,
      role: stages.semanticRole,
      pipelineId: contacts.pipelineId,
      ghlCreatedAt: contacts.ghlCreatedAt,
      createdAt: contacts.createdAt,
      ghlOpportunityId: contacts.ghlOpportunityId,
      opportunityCreatedAt: contacts.opportunityCreatedAt,
      monetaryValueCents: contacts.monetaryValueCents,
      origin: contacts.origin,
      campaign: contacts.utmCampaign,
      attribution: contacts.attributionClass,
    })
    .from(contacts)
    .leftJoin(stages, eq(contacts.stageId, stages.id))
    .where(pipelineIds.length ? inArray(contacts.pipelineId, pipelineIds) : sql`false`);
  const contactIds = contactRows.map((c) => c.id);

  // F14 (2026-09-30): "applied" = the APPLICATION — the followed-pipeline opportunity's createdAt (GHL counted 186
  // applications in August; dating by contact creation gave 98 and never counted a returning contact who re-applied).
  const oppIds = Array.from(new Set(contactRows.map((c) => c.ghlOpportunityId).filter((x): x is string => Boolean(x))));
  const oppCreated = new Map<string, Date | null>();
  const movedIn = new Map<string, Date>();
  if (oppIds.length) {
    for (const o of await db.select({ id: ghlOpportunities.id, created: ghlOpportunities.ghlCreatedAt }).from(ghlOpportunities).where(inArray(ghlOpportunities.id, oppIds))) oppCreated.set(o.id, o.created);
    // An application first seen in ANOTHER pipeline is dated by its entry into the followed one (flagged).
    const seen = await db
      .select({ opp: stageTransitions.ghlOpportunityId, pipelineId: stageTransitions.pipelineId, at: stageTransitions.observedAt })
      .from(stageTransitions)
      .where(inArray(stageTransitions.ghlOpportunityId, oppIds));
    const byOpp = new Map<string, Array<{ pipelineId: string | null; at: Date }>>();
    for (const t of seen) if (t.opp) byOpp.set(t.opp, [...(byOpp.get(t.opp) ?? []), { pipelineId: t.pipelineId, at: t.at }]);
    const followedSet = new Set(pipelineIds);
    for (const [opp, rows] of byOpp) {
      const sorted = rows.sort((a, b) => a.at.getTime() - b.at.getTime());
      const firstElsewhere = sorted.find((r) => r.pipelineId && !followedSet.has(r.pipelineId));
      const entered = sorted.find((r) => r.pipelineId && followedSet.has(r.pipelineId) && firstElsewhere && r.at > firstElsewhere.at);
      if (firstElsewhere && entered) movedIn.set(opp, entered.at);
    }
  }
  const health: InputHealth = { applicantsWithoutDate: [], appliedFromMove: 0 };
  const appliedDate = (c: (typeof contactRows)[number]): string | null => {
    if (c.origin === 'demo') return localDate(c.ghlCreatedAt ?? c.createdAt, tz); // fabricated sample rows have no applications
    const opp = c.ghlOpportunityId;
    const moved = opp ? movedIn.get(opp) : undefined;
    if (moved) {
      health.appliedFromMove += 1;
      return localDate(moved, tz);
    }
    const created = (opp ? oppCreated.get(opp) : null) ?? c.opportunityCreatedAt ?? null;
    if (created) return localDate(created, tz);
    health.applicantsWithoutDate.push({ contactId: c.id, name: `${c.firstName} ${c.lastName}`.trim() || c.email || 'Unknown' });
    return null;
  };

  const transitionRows = contactIds.length
    ? await db
        .select({
          contactId: stageTransitions.contactId,
          // F4 (2026-09-30): roles resolved through the stage NOW (a Setup remap reaches history); the stored
          // role only when the stage no longer exists — lib/metrics/transitionRoles.ts.
          fromRole: resolvedFromRole,
          toRole: resolvedToRole,
          toStageId: stageTransitions.toStageId,
          observedAt: stageTransitions.observedAt,
        })
        .from(stageTransitions)
        .leftJoin(toStage, toStageJoin)
        .leftJoin(fromStage, fromStageJoin)
        .where(inArray(stageTransitions.contactId, contactIds))
    : [];

  // Appointments: the whole window plus a tail on either side so to-do
  // buckets ("no later booking") and show rates see the full picture.
  const apptRows = await db
    .select({
      contactId: appointments.contactId,
      type: appointments.type,
      outcome: appointments.outcome,
      startTime: appointments.startTime,
    })
    .from(appointments)
    .where(and(gte(appointments.startTime, new Date(start.getTime() - 120 * 86_400_000)), lte(appointments.startTime, new Date(end.getTime() + 120 * 86_400_000))));

  // Manual weekly rows are dated by their Sunday, so widen by a week each side.
  const spendRows = await db
    .select({
      date: adSpend.date,
      platform: adSpend.platform,
      spendCents: adSpend.spendCents,
      currency: adSpend.currency,
      origin: adSpend.origin,
      level: adSpend.level,
      campaignId: adSpend.campaignId,
      campaignName: adSpend.campaignName,
      adsetName: adSpend.adsetName,
      adName: adSpend.adName,
      impressions: adSpend.impressions,
      clicks: adSpend.clicks,
      leads: adSpend.leads,
      reach: adSpend.reach,
      linkClicks: adSpend.linkClicks,
      landingPageViews: adSpend.landingPageViews,
      purchases: adSpend.purchases,
    })
    .from(adSpend)
    .where(and(gte(adSpend.date, shiftDate(opts.start, -7)), lte(adSpend.date, shiftDate(opts.end, 7))));

  const paymentRows = await db
    .select({
      id: payments.id,
      stripeId: payments.stripeId,
      contactId: payments.contactId,
      kind: payments.kind,
      amountCents: payments.amountCents,
      refundedCents: payments.refundedCents,
      currency: payments.currency,
      status: payments.status,
      paidAt: payments.paidAt,
      failedAt: payments.failedAt,
      origin: payments.origin,
      email: payments.email,
      customerName: payments.customerName,
      description: payments.description,
      matchSource: payments.matchSource,
      paymentClass: payments.paymentClass,
      invoiceId: sql<string | null>`${payments.metadata}->>'invoice'`,
    })
    .from(payments);

  const money = await loadMoneyContext();
  // Amounts keep their stored currency; the engine converts at read time.
  // A code the business does not report in (only CAD / USD exist today) is
  // dropped and counted, never summed as if it were either.
  let unsupported = 0;
  const withCurrency = <T extends { currency: string }>(rows: T[]): Array<Omit<T, 'currency'> & { currency: Currency }> => {
    const out: Array<Omit<T, 'currency'> & { currency: Currency }> = [];
    for (const r of rows) {
      const currency = parseCurrency(r.currency);
      if (currency) out.push({ ...r, currency });
      else unsupported += 1;
    }
    return out;
  };
  const spend: SpendRow[] = withCurrency(spendRows);
  const paymentList = withCurrency(paymentRows);

  const result: MetricsInput = {
    money: { ...money, unsupportedRows: unsupported },
    contacts: contactRows.map((c) => ({
      id: c.id,
      name: `${c.firstName} ${c.lastName}`.trim() || c.email || 'Unknown',
      email: c.email,
      source: c.source,
      stageId: c.stageId,
      stageName: c.stageName ?? null,
      role: c.role ?? null,
      appliedOn: appliedDate(c),
      monetaryValueCents: c.monetaryValueCents ?? 0,
      origin: c.origin,
      campaign: c.campaign,
      attribution: c.attribution ?? null,
    })),
    transitions: transitionRows.map((t) => ({
      contactId: t.contactId,
      fromRole: t.fromRole ?? null,
      toRole: t.toRole ?? null,
      toStageId: t.toStageId,
      on: localDate(t.observedAt, tz),
      atMs: t.observedAt.getTime(),
    })),
    appointments: apptRows.map((a) => ({
      contactId: a.contactId,
      type: a.type,
      outcome: a.outcome,
      on: localDate(a.startTime, tz),
      atMs: a.startTime.getTime(),
    })),
    spend,
    payments: paymentList.map((p): PaymentRow => ({
      id: p.id,
      stripeId: p.stripeId,
      contactId: p.contactId,
      kind: p.kind,
      amountCents: p.amountCents,
      refundedCents: p.refundedCents,
      currency: p.currency,
      status: p.status,
      on: p.paidAt ? localDate(p.paidAt, tz) : p.failedAt ? localDate(p.failedAt, tz) : null,
      origin: p.origin,
      email: p.email,
      customerName: p.customerName,
      description: p.description,
      matchSource: p.matchSource,
      paymentClass: p.paymentClass ?? null,
      invoiceId: p.invoiceId ?? null,
    })),
  };
  // Computed while mapping the contacts above (appliedDate fills it).
  result.health = health;
  result.asOfMs = Date.now(); // F2: appointments after now are not "past" for show-rate coverage
  return result;
}
