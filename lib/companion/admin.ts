/**
 * Companion stage 2 — the owner's state for Setup → Companion (one reader behind GET /api/setup/companion) and the
 * validated PATCH of its settings.
 */

import { setSetting } from '../settings';
import { COMPANION_SETTING_KEYS, readDryRun, type DryRunState, type RescheduleAppointment } from './config';
import { getCompanionWriteConfig } from './ghlWrite';
import { catalogueRows, readOutcomeCatalogue } from './outcomeService';
import { validateOverrides, type OutcomeDef, type OutcomeOverride } from './outcomes';
import { listFailedActions, type FailedActionSummary } from './actions';

export interface CompanionAdminState {
  writeKey: { configured: boolean; preview: string | null };
  dryRun: DryRunState;
  rescheduleAppointment: RescheduleAppointment;
  outcomeMap: {
    outcomes: Array<OutcomeDef & { resolvedStage: { id: string; name: string } | null }>;
    overridden: string[];
    overridesRaw: Record<string, OutcomeOverride>;
    warnings: string[];
    pipeline: { id: string; name: string; stageCount: number } | null;
  };
  failedLogs: FailedActionSummary[];
}

export async function getCompanionAdminState(): Promise<CompanionAdminState> {
  const [writeKey, dryRun, cat, failedLogs] = await Promise.all([getCompanionWriteConfig(), readDryRun(), readOutcomeCatalogue(), listFailedActions()]);
  return {
    writeKey,
    dryRun,
    rescheduleAppointment: cat.reschedule,
    outcomeMap: {
      outcomes: catalogueRows(cat),
      overridden: Object.keys(cat.overrides),
      overridesRaw: cat.overrides,
      warnings: cat.warnings,
      pipeline: cat.pipeline ? { id: cat.pipeline.id, name: cat.pipeline.name, stageCount: cat.pipeline.stages.length } : null,
    },
    failedLogs,
  };
}

export type AdminPatchResult = { ok: true; changed: string[] } | { ok: false; status: 400; error: string };

/**
 * PATCH { dryRun?, confirm?, rescheduleAppointment?, outcomeMap? } — each key validated; dry run OFF needs
 * `confirm: true` (the owner saw the sentence). Nothing is written unless everything validates.
 */
export async function patchCompanionSettings(input: unknown): Promise<AdminPatchResult> {
  if (!input || typeof input !== 'object') return { ok: false, status: 400, error: 'Send an object of settings.' };
  const body = input as Record<string, unknown>;
  const writes: Array<[string, string]> = [];
  const changed: string[] = [];
  if ('dryRun' in body) {
    if (typeof body.dryRun !== 'boolean') return { ok: false, status: 400, error: 'dryRun must be true or false.' };
    if (body.dryRun === false && body.confirm !== true) return { ok: false, status: 400, error: 'Confirm turning dry run off: outcomes will be sent to GoHighLevel.' };
    writes.push([COMPANION_SETTING_KEYS.dryRun, body.dryRun ? 'true' : 'false']);
    changed.push('dryRun');
  }
  if ('rescheduleAppointment' in body) {
    if (body.rescheduleAppointment !== 'cancelled' && body.rescheduleAppointment !== 'leave') return { ok: false, status: 400, error: 'rescheduleAppointment must be "cancelled" or "leave".' };
    writes.push([COMPANION_SETTING_KEYS.rescheduleAppointment, body.rescheduleAppointment]);
    changed.push('rescheduleAppointment');
  }
  if ('outcomeMap' in body) {
    const v = validateOverrides(body.outcomeMap);
    if (!v.ok) return { ok: false, status: 400, error: v.error };
    writes.push([COMPANION_SETTING_KEYS.outcomeMap, JSON.stringify(v.overrides)]);
    changed.push('outcomeMap');
  }
  if (writes.length === 0) return { ok: false, status: 400, error: 'Nothing to change: send dryRun, rescheduleAppointment or outcomeMap.' };
  for (const [k, v] of writes) await setSetting(k, v);
  return { ok: true, changed };
}
