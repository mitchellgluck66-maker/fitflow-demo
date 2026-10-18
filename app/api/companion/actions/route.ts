import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse, dbTimeout } from '@/lib/dbTimeout';
import { currentUser, userErrorResponse } from '@/lib/auth/currentUser';
import { actionView, executeLog } from '@/lib/companion/log';
import { ExecuteBodySchema, firstIssue } from '@/lib/companion/logRequest';
import { timezoneFor } from '@/lib/companion/service';
import { resolveViewing } from '@/lib/companion/viewing';

export const dynamic = 'force-dynamic';

/**
 * POST /api/companion/actions { requestId, contact, call?, outcome, note, expectedStageId, acceptedStageId? } —
 * confirm: GHL is re-read (409 `staleStage` when the stage moved since the sheet opened and was not accepted; 502
 * when GHL cannot be read — nothing written), the request id is claimed (a resent id returns the existing log),
 * the steps run in order, each result is stored as it lands. The response is the log's view (`state` ok | partial |
 * failed | dry_run) with per-step results; HTTP 200 whatever the steps did — the state says.
 */
export async function POST(request: NextRequest) {
  const me = await currentUser();
  if (!me.ok) return userErrorResponse(me);
  try {
    const parsed = ExecuteBodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
    const v = await resolveViewing(me.user, null);
    const timezone = v.ok ? await timezoneFor(v.viewing) : 'UTC';
    const b = parsed.data;
    const now = new Date();
    const r = await dbTimeout(
      executeLog({ requestId: b.requestId, ghlContactId: b.contact, call: b.call, outcome: b.outcome, note: b.note, user: me.user, timezone, expectedStageId: b.expectedStageId, acceptedStageId: b.acceptedStageId ?? null, now }),
      'companion log',
      120_000,
    );
    if (!r.ok) return NextResponse.json(r.status === 409 ? { error: r.error, staleStage: r.staleStage } : { error: r.error }, { status: r.status });
    return NextResponse.json({ created: r.created, action: actionView(r.action, new Date(), me.user) });
  } catch (error) {
    return apiErrorResponse(error, 'Failed to log the outcome');
  }
}
