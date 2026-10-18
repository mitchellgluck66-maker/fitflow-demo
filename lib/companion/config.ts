/**
 * Companion stage 2 — the owner's settings for outcome logging (keys + pure parsers).
 *
 *   ghl_companion_write_token        the SEPARATE GoHighLevel key the write module uses (secret, sealed at rest).
 *                                    The read-only key (`ghl_api_token`) is never used for a write and this one is
 *                                    never used for a sync.
 *   companion_dry_run                'true' (default) | 'false'. Anything else reads as ON — fail safe.
 *   companion_reschedule_appointment 'cancelled' (default) | 'leave' — what a Reschedule outcome does to the event.
 *   companion_outcome_map            JSON overrides per outcome key (lib/companion/outcomes#applyOverrides).
 */

import { getSetting } from '../settings';

export const COMPANION_SETTING_KEYS = {
  writeToken: 'ghl_companion_write_token',
  dryRun: 'companion_dry_run',
  rescheduleAppointment: 'companion_reschedule_appointment',
  outcomeMap: 'companion_outcome_map',
} as const;

export type RescheduleAppointment = 'cancelled' | 'leave';
export const RESCHEDULE_APPOINTMENT_DEFAULT: RescheduleAppointment = 'cancelled';

export interface DryRunState {
  on: boolean;
  /** Set when the stored value was not 'true' / 'false' (read as ON). */
  invalidValue: string | null;
}

/** 'false' is the only value that turns dry run OFF; a missing or malformed row is ON. */
export function dryRunOf(value: string | null | undefined): DryRunState {
  if (value === null || value === undefined || value === '') return { on: true, invalidValue: null };
  if (value === 'true') return { on: true, invalidValue: null };
  if (value === 'false') return { on: false, invalidValue: null };
  return { on: true, invalidValue: value };
}

export function rescheduleAppointmentOf(value: string | null | undefined): RescheduleAppointment {
  return value === 'leave' ? 'leave' : RESCHEDULE_APPOINTMENT_DEFAULT;
}

export async function readDryRun(): Promise<DryRunState> {
  return dryRunOf(await getSetting(COMPANION_SETTING_KEYS.dryRun));
}

export async function readRescheduleAppointment(): Promise<RescheduleAppointment> {
  return rescheduleAppointmentOf(await getSetting(COMPANION_SETTING_KEYS.rescheduleAppointment));
}
