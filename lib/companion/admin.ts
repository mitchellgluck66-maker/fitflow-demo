/**
 * Companion stage 2 — the owner's state for Setup → Companion (one reader behind GET /api/setup/companion).
 */

import { readDryRun, type DryRunState } from './config';
import { getCompanionWriteConfig } from './ghlWrite';

export interface CompanionAdminState {
  writeKey: { configured: boolean; preview: string | null };
  dryRun: DryRunState;
}

export async function getCompanionAdminState(): Promise<CompanionAdminState> {
  const [writeKey, dryRun] = await Promise.all([getCompanionWriteConfig(), readDryRun()]);
  return { writeKey, dryRun };
}
