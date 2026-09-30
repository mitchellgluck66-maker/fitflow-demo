import { NextRequest, NextResponse } from 'next/server';
import { apiErrorResponse } from '@/lib/dbTimeout';
import { addNote, decideNote, deleteNote, getOwnerProfile, listNotes, profileGaps, withheldLine } from '@/lib/analyst/notes';
import { rebuildBrief } from '@/lib/analyst/briefService';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/** The brief is rebuilt whenever the notes change; a failure is reported, the note change stands. */
async function rebuildAfterNotes(): Promise<{ rebuilt: boolean; error?: string }> {
  try {
    await rebuildBrief({ trigger: 'notes' });
    return { rebuilt: true };
  } catch (error) {
    return { rebuilt: false, error: `Brief rebuild failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** GET — every note (active, proposed, rejected), the owner profile and its gaps. */
export async function GET() {
  try {
    const [notes, profile] = await Promise.all([listNotes(), getOwnerProfile()]);
    const gaps = profileGaps(profile);
    return NextResponse.json({ notes, profile, gaps, withheld: withheldLine(gaps) });
  } catch (error) {
    return apiErrorResponse(error, 'Failed to read notes');
  }
}

/** POST { text } — an owner note (active at once). */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as { text?: unknown };
    if (typeof body.text !== 'string' || !body.text.trim()) return NextResponse.json({ error: 'A note needs text' }, { status: 400 });
    const note = await addNote(body.text, { source: 'owner' });
    return NextResponse.json({ ok: true, note, ...(await rebuildAfterNotes()) });
  } catch (error) {
    return apiErrorResponse(error, 'Failed to add the note');
  }
}

/** PATCH { id, decision: 'active' | 'rejected' } — the owner decides an Analyst proposal. */
export async function PATCH(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as { id?: unknown; decision?: unknown };
    if (typeof body.id !== 'string' || (body.decision !== 'active' && body.decision !== 'rejected')) return NextResponse.json({ error: 'id and decision (active | rejected) are required' }, { status: 400 });
    const note = await decideNote(body.id, body.decision);
    if (!note) return NextResponse.json({ error: 'No proposed note with that id' }, { status: 404 });
    return NextResponse.json({ ok: true, note, ...(body.decision === 'active' ? await rebuildAfterNotes() : { rebuilt: false }) });
  } catch (error) {
    return apiErrorResponse(error, 'Failed to decide the note');
  }
}

/** DELETE { id } */
export async function DELETE(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as { id?: unknown };
    if (typeof body.id !== 'string') return NextResponse.json({ error: 'id is required' }, { status: 400 });
    const removed = await deleteNote(body.id);
    if (!removed) return NextResponse.json({ error: 'No note with that id' }, { status: 404 });
    return NextResponse.json({ ok: true, ...(await rebuildAfterNotes()) });
  } catch (error) {
    return apiErrorResponse(error, 'Failed to delete the note');
  }
}
