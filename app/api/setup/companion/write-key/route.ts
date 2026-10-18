import { NextRequest, NextResponse } from 'next/server';
import { requireOwner } from '@/lib/auth/currentUser';
import { setSetting } from '@/lib/settings';
import { CredentialsKeyError } from '@/lib/crypto/credentials';
import { COMPANION_SETTING_KEYS } from '@/lib/companion/config';
import { getCompanionWriteConfig, verifyWriteToken } from '@/lib/companion/ghlWrite';

export const dynamic = 'force-dynamic';

/**
 * POST /api/setup/companion/write-key { token? } — save the Companion write key (sealed), then verify it with the
 * write module's read probe. `{ verify: true }` alone re-verifies the stored key. Owner only. The token is never
 * echoed; only its masked tail comes back.
 */
export async function POST(request: NextRequest) {
  const owner = await requireOwner();
  if (!owner.ok) return owner.response;
  try {
    const body = (await request.json().catch(() => ({}))) as { token?: unknown; verify?: unknown };
    if (typeof body.token === 'string' && body.token.trim()) {
      await setSetting(COMPANION_SETTING_KEYS.writeToken, body.token.trim(), { secret: true });
    } else if (body.verify !== true) {
      return NextResponse.json({ error: 'Paste a write key, or send { verify: true } to re-check the stored one.' }, { status: 400 });
    }
    const verification = await verifyWriteToken();
    const config = await getCompanionWriteConfig();
    return NextResponse.json({ ok: verification.ok, verification, writeKey: config });
  } catch (error) {
    if (error instanceof CredentialsKeyError) return NextResponse.json({ error: error.message, locked: true }, { status: 503 });
    return NextResponse.json({ error: 'Failed to save the write key', detail: String(error) }, { status: 500 });
  }
}

/** DELETE — forget the stored write key. Every log attempt is refused until a new one is saved. */
export async function DELETE() {
  const owner = await requireOwner();
  if (!owner.ok) return owner.response;
  try {
    await setSetting(COMPANION_SETTING_KEYS.writeToken, '', { secret: true });
    return NextResponse.json({ ok: true, message: 'Companion write key cleared — outcome logging is refused until a new key is saved.', writeKey: await getCompanionWriteConfig() });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to clear the write key', detail: String(error) }, { status: 500 });
  }
}
