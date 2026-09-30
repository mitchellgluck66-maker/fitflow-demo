import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse } from '@/lib/dbTimeout';
import { setSetting, getTimezone } from '@/lib/settings';
import { ANALYST_DEFAULTS, ANALYST_KEYS, ANALYST_MODEL_OPTIONS, getAnalystConfig, type Effort } from '@/lib/analyst/config';
import { analystStore } from '@/lib/analyst/store';
import { currentBrief, describeBrief } from '@/lib/analyst/briefService';
import { getOwnerProfile, profileGaps, withheldLine } from '@/lib/analyst/notes';

export const dynamic = 'force-dynamic';

async function state() {
  const [config, timezone, brief, profile] = await Promise.all([getAnalystConfig(), getTimezone(), currentBrief(), getOwnerProfile()]);
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const spentMonthUsd = await analystStore().spentUsdSince(monthStart);
  const gaps = profileGaps(profile);
  return {
    configured: config.configured,
    modelDefault: config.modelDefault,
    modelDeep: config.modelDeep,
    modelOptions: ANALYST_MODEL_OPTIONS,
    effort: config.effort,
    answerMode: config.answerMode,
    capRunUsd: config.capRunUsd,
    capMonthUsd: config.capMonthUsd,
    defaults: ANALYST_DEFAULTS,
    spentMonthUsd: Math.round(spentMonthUsd * 100) / 100,
    brief: { built: Boolean(brief), summary: describeBrief(brief, timezone), tokens: brief?.tokens ?? null, dataThrough: brief?.dataThrough ?? null, builtAt: brief?.builtAt.toISOString() ?? null },
    gaps,
    withheld: withheldLine(gaps),
  };
}

export async function GET() {
  try {
    return NextResponse.json(await state());
  } catch (error) {
    return apiErrorResponse(error, 'Failed to read Analyst settings');
  }
}

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** POST { modelDefault?, modelDeep?, effort?, answerMode?, capRunUsd?, capMonthUsd? } */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const models = ANALYST_MODEL_OPTIONS as readonly string[];
    if (typeof body.modelDefault === 'string' && models.includes(body.modelDefault)) await setSetting(ANALYST_KEYS.modelDefault, body.modelDefault);
    if (typeof body.modelDeep === 'string' && models.includes(body.modelDeep)) await setSetting(ANALYST_KEYS.modelDeep, body.modelDeep);
    if (typeof body.effort === 'string' && EFFORTS.includes(body.effort as Effort)) await setSetting(ANALYST_KEYS.effort, body.effort);
    if (body.answerMode === 'format' || body.answerMode === 'submit_answer') await setSetting(ANALYST_KEYS.answerMode, body.answerMode);
    if (typeof body.capRunUsd === 'number' && body.capRunUsd >= 0) await setSetting(ANALYST_KEYS.capRunUsd, String(body.capRunUsd));
    if (typeof body.capMonthUsd === 'number' && body.capMonthUsd >= 0) await setSetting(ANALYST_KEYS.capMonthUsd, String(body.capMonthUsd));
    return NextResponse.json({ ok: true, ...(await state()) });
  } catch (error) {
    return apiErrorResponse(error, 'Failed to save Analyst settings');
  }
}
