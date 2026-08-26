/**
 * Account discovery and auto-mapping.
 *
 * Before anything can be imported the app has to learn the shape of the real
 * GoHighLevel account: which calendars exist (they define appointment types),
 * which pipeline to track, and what the stage UUIDs are. Stage ids are opaque
 * UUIDs that differ per account, so they cannot be hardcoded - they have to be
 * read at setup time and stored.
 */

import { listCalendars, listPipelines, listUsers } from './client';
import { setSetting, SETTING_KEYS } from '../settings';
import type { GhlCalendar, GhlPipeline } from './types';

/** The app's canonical stages, in funnel order. */
export const LOCAL_STAGES = [
  'Applied',
  'Consult Booked',
  'Consult No Show',
  'Pre-Roadmap Booked',
  'Roadmap No Show',
  'Roadmap Completed: Objection',
  'Enrolled',
] as const;

/** The appointment types the Today View understands. */
export const LOCAL_TYPES = ['Consult', 'Roadmap', 'Follow-Up', 'Check-In'] as const;

function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Score how well a GHL stage name matches one of ours.
 * Exact match wins; then containment; then token overlap. Returns 0..1.
 */
function similarity(a: string, b: string): number {
  const na = normalise(a);
  const nb = normalise(b);

  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;

  const tokensA = new Set(a.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const tokensB = new Set(b.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let shared = 0;
  for (const token of tokensA) if (tokensB.has(token)) shared += 1;

  return shared / Math.max(tokensA.size, tokensB.size);
}

export interface StageMapping {
  localStage: string;
  ghlStageId: string | null;
  ghlStageName: string | null;
  confidence: number;
  /** True when the match was weak enough that a human should confirm it. */
  needsReview: boolean;
}

/**
 * Best-effort mapping from the app's stages onto a real pipeline's stages.
 *
 * Deliberately conservative: anything below a 0.5 score is flagged for review
 * rather than silently accepted. A wrong stage mapping would move real
 * opportunities to the wrong place in the client's pipeline, which is the most
 * damaging mistake this integration can make.
 */
export function buildStageMapping(pipeline: GhlPipeline): StageMapping[] {
  const stages = pipeline.stages ?? [];

  return LOCAL_STAGES.map((localStage) => {
    let best: { id: string; name: string; score: number } | null = null;

    for (const stage of stages) {
      const name = stage.name ?? '';
      const score = similarity(localStage, name);
      if (!best || score > best.score) {
        best = { id: stage.id, name, score };
      }
    }

    const confidence = best?.score ?? 0;

    return {
      localStage,
      ghlStageId: confidence >= 0.5 ? (best?.id ?? null) : null,
      ghlStageName: confidence >= 0.5 ? (best?.name ?? null) : null,
      confidence: Math.round(confidence * 100) / 100,
      needsReview: confidence < 0.8,
    };
  });
}

/** Map a calendar name onto one of our appointment types. */
export function inferAppointmentType(calendarName: string): string {
  let best: { type: string; score: number } = { type: 'Consult', score: 0 };

  for (const type of LOCAL_TYPES) {
    const score = similarity(type, calendarName);
    if (score > best.score) best = { type, score };
  }

  // Common naming that similarity alone won't catch.
  const lower = calendarName.toLowerCase();
  if (lower.includes('roadmap') || lower.includes('strategy')) return 'Roadmap';
  if (lower.includes('consult') || lower.includes('discovery') || lower.includes('intro'))
    return 'Consult';
  if (lower.includes('follow')) return 'Follow-Up';
  if (lower.includes('check')) return 'Check-In';

  return best.score >= 0.5 ? best.type : 'Consult';
}

export interface DiscoveryResult {
  ok: boolean;
  error?: string;
  calendars: Array<{
    id: string;
    name: string;
    inferredType: string;
    calendarType?: string;
  }>;
  pipelines: Array<{
    id: string;
    name: string;
    stages: Array<{ id: string; name: string }>;
    stageCount: number;
  }>;
  users: Array<{ id: string; name: string; email?: string }>;
  /** Auto-mapping against the best-guess pipeline. */
  suggestedPipelineId: string | null;
  stageMapping: StageMapping[];
}

/**
 * Read the account's structure. Pure discovery - writes nothing to GHL and
 * nothing to local tables until the user confirms.
 */
export async function discoverAccount(): Promise<DiscoveryResult> {
  const empty: DiscoveryResult = {
    ok: false,
    calendars: [],
    pipelines: [],
    users: [],
    suggestedPipelineId: null,
    stageMapping: [],
  };

  const [calendarsRes, pipelinesRes, usersRes] = await Promise.all([
    listCalendars(),
    listPipelines(),
    listUsers(),
  ]);

  if (calendarsRes.dryRun) {
    return {
      ...empty,
      error:
        'Running in dry-run mode with no credentials. Add GHL_API_TOKEN and GHL_LOCATION_ID to .env.local, then set GHL_DRY_RUN=false.',
    };
  }

  if (!calendarsRes.ok) {
    return { ...empty, error: calendarsRes.error ?? 'Could not reach GoHighLevel' };
  }

  const rawCalendars: GhlCalendar[] = calendarsRes.data?.calendars ?? [];
  const rawPipelines: GhlPipeline[] = pipelinesRes.ok
    ? (pipelinesRes.data?.pipelines ?? [])
    : [];

  // Prefer a pipeline whose name hints at onboarding/application, else the one
  // with the most stages, else the first.
  const suggested =
    rawPipelines.find((p) =>
      /appl|onboard|sales|client/i.test(p.name ?? ''),
    ) ??
    [...rawPipelines].sort(
      (a, b) => (b.stages?.length ?? 0) - (a.stages?.length ?? 0),
    )[0] ??
    null;

  return {
    ok: true,
    calendars: rawCalendars.map((c) => ({
      id: c.id,
      name: c.name ?? 'Untitled calendar',
      inferredType: inferAppointmentType(c.name ?? ''),
      calendarType: c.calendarType,
    })),
    pipelines: rawPipelines.map((p) => ({
      id: p.id,
      name: p.name ?? 'Untitled pipeline',
      stages: (p.stages ?? []).map((s) => ({ id: s.id, name: s.name ?? '' })),
      stageCount: p.stages?.length ?? 0,
    })),
    users: usersRes.ok
      ? (usersRes.data?.users ?? []).map((u) => ({
          id: u.id,
          name: u.name ?? u.email ?? u.id,
          email: u.email,
        }))
      : [],
    suggestedPipelineId: suggested?.id ?? null,
    stageMapping: suggested ? buildStageMapping(suggested) : [],
  };
}

/** Persist the confirmed mapping so the sync engine can resolve stage UUIDs. */
export async function saveMapping(params: {
  pipelineId: string;
  stageMap: Record<string, string>;
  calendarMap: Record<string, string>;
}): Promise<void> {
  await setSetting(SETTING_KEYS.ghlPipelineId, params.pipelineId);
  await setSetting(SETTING_KEYS.ghlStageMap, JSON.stringify(params.stageMap));
  await setSetting(SETTING_KEYS.ghlCalendarMap, JSON.stringify(params.calendarMap));
}
