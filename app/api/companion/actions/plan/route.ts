import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, dbTimeout } from '@/lib/dbTimeout';
import { currentUser, userErrorResponse } from '@/lib/auth/currentUser';
import { planLog } from '@/lib/companion/log';
import { PlanBodySchema, firstIssue } from '@/lib/companion/logRequest';
import { timezoneFor } from '@/lib/companion/service';
import { resolveViewing } from '@/lib/companion/viewing';

export const dynamic = 'force-dynamic';

/**
 * POST /api/companion/actions/plan { contact, call?, outcome: { key } | { move }, note } — the confirmation sheet:
 * the resolved stage move, the appointment change, the note text, the sentence, the expected stage. Writes nothing.
 * 422 with the reason when the note is short, the role is unmapped or the outcome does not fit the call; 412 when
 * dry run is off and no write key is saved.
 */
export async function POST(request: NextRequest) {
  const me = await currentUser();
  if (!me.ok) return userErrorResponse(me);
  try {
    const parsed = PlanBodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
    const v = await resolveViewing(me.user, null);
    const timezone = v.ok ? await timezoneFor(v.viewing) : 'UTC';
    const r = await dbTimeout(planLog({ ghlContactId: parsed.data.contact, call: parsed.data.call, outcome: parsed.data.outcome, note: parsed.data.note, user: me.user, timezone }), 'companion plan');
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ plan: r.plan });
  } catch (error) {
    return apiErrorResponse(error, 'Failed to plan the log');
  }
}
