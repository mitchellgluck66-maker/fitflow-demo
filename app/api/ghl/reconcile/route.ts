import { NextResponse } from 'next/server';
import { runReconcile, readReconcileSummary } from '@/lib/ghl/reconcile';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** GET — the last reconciliation summary. */
export async function GET() {
  return NextResponse.json({ summary: await readReconcileSummary() });
}

/** POST — reconcile now (read-only against GHL: one cheap count per followed stage). */
export async function POST() {
  const r = await runReconcile({ trigger: 'manual' });
  return NextResponse.json(r, { status: r.ok || r.notConfigured ? 200 : 500 });
}
