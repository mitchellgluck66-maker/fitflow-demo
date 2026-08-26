import { NextResponse } from 'next/server';
import { ENABLE_WRITEBACK } from '@/lib/ghl/config';

export const dynamic = 'force-dynamic';

/**
 * DORMANT. Attendance marking was removed from FitFlow when it became a
 * read-only dashboard (CLAUDE.md rule 1). Miranda records show/no-show in
 * GoHighLevel and it mirrors here on the next sync. The original marking +
 * write-back implementation lives in git history (v1 baseline) and would only
 * ever be restored behind ENABLE_WRITEBACK, which is hard-off.
 */
const DISABLED = {
  error:
    'Attendance marking is disabled: FitFlow is read-only. Record the outcome in GoHighLevel and it will appear here after the next hourly sync.',
  writebackEnabled: ENABLE_WRITEBACK,
};

export async function POST() {
  return NextResponse.json(DISABLED, { status: 403 });
}

export async function DELETE() {
  return NextResponse.json(DISABLED, { status: 403 });
}
