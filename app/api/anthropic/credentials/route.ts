import { NextRequest, NextResponse } from 'next/server';
import { desc, eq } from 'drizzle-orm';
import { db, aiReports } from '@/db';
import { setSetting } from '@/lib/settings';
import { getAnthropicConfig, maskToken, ANTHROPIC_KEYS, MODEL_OPTIONS, DEFAULT_MODEL } from '@/lib/anthropic/config';
import { testConnection } from '@/lib/anthropic/client';

export const dynamic = 'force-dynamic';

async function lastGenerated() {
  const [row] = await db.select({ kind: aiReports.kind, createdAt: aiReports.createdAt, model: aiReports.model }).from(aiReports).where(eq(aiReports.kind, 'insight')).orderBy(desc(aiReports.createdAt)).limit(1);
  return row ? { kind: row.kind, at: row.createdAt.toISOString(), model: row.model } : null;
}

/** GET — masked state; the key is never returned. */
export async function GET() {
  try {
    const config = await getAnthropicConfig();
    return NextResponse.json({
      configured: config.configured,
      source: config.source,
      keyPreview: maskToken(config.key),
      model: config.model,
      modelOptions: MODEL_OPTIONS,
      defaultModel: DEFAULT_MODEL,
      lastGenerated: await lastGenerated(),
    });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to read Anthropic credentials', detail: String(error) }, { status: 500 });
  }
}

/** POST {apiKey?, model?} — save, then verify with one tiny request. */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
      await setSetting(ANTHROPIC_KEYS.apiKey, body.apiKey.trim(), { secret: true });
    }
    if (typeof body.model === 'string') {
      await setSetting(ANTHROPIC_KEYS.model, body.model.trim());
    }
    const config = await getAnthropicConfig();
    const verification = config.configured ? await testConnection() : { ok: false, configured: false, message: 'An API key is required.' };
    return NextResponse.json({
      ok: verification.ok,
      verification,
      configured: config.configured,
      source: config.source,
      keyPreview: maskToken(config.key),
      model: config.model,
    });
  } catch (error) {
    console.error('Failed to save Anthropic credentials');
    return NextResponse.json({ error: 'Failed to save Anthropic credentials', detail: String(error) }, { status: 500 });
  }
}

/** DELETE — forget the stored key (env var, if any, remains). */
export async function DELETE() {
  try {
    await setSetting(ANTHROPIC_KEYS.apiKey, '', { secret: true });
    const config = await getAnthropicConfig();
    return NextResponse.json({ ok: true, configured: config.configured, source: config.source, message: config.source === 'env' ? 'Stored key cleared. Falling back to ANTHROPIC_API_KEY.' : 'Stored key cleared.' });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to clear Anthropic credentials', detail: String(error) }, { status: 500 });
  }
}
