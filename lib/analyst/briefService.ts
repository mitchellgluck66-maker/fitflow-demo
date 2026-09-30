/**
 * Brief storage + the dispatch step (plan item 3). `rebuildBrief` loads the
 * rows once (first data → today), calls the pure builder, counts the tokens
 * with the API when a key is stored (the count endpoint is free), and inserts
 * a row. A build error THROWS: the dispatch marks the step failed with the
 * reason and the previous brief stays in place. With no brief at all the
 * Analyst refuses to start ("The business brief hasn't been built yet").
 */

import { desc } from 'drizzle-orm';
import { db, analystBriefs } from '@/db';
import { loadMetricsInput } from '../metrics/load';
import { getSetting, getTimezone, setSetting, SETTING_KEYS } from '../settings';
import { todayInTimezone, localDate } from '../dates';
import { buildBrief, type Brief } from './brief';
import { activeNotes, getOwnerProfile } from './notes';
import { ANALYST_KEYS, getAnalystConfig } from './config';
import { makeAnalystClient } from './api';
import { describeError } from '../anthropic/client';

export interface StoredBrief {
  id: string;
  hash: string;
  text: string;
  tokens: number | null;
  dataThrough: string;
  builtAt: Date;
}

export async function currentBrief(): Promise<StoredBrief | null> {
  const [row] = await db.select().from(analystBriefs).orderBy(desc(analystBriefs.builtAt)).limit(1);
  return row ? { id: row.id, hash: row.hash, text: row.text, tokens: row.tokens, dataThrough: row.dataThrough, builtAt: row.builtAt } : null;
}

export interface RebuildResult {
  ok: true;
  hash: string;
  tokens: number | null;
  dataThrough: string;
  /** Same hash as the previous brief: nothing changed (still recorded — the row carries the build time). */
  unchanged: boolean;
  weeks: number;
  reason: string;
  /** Present when the token count was skipped or failed (the brief is still stored). */
  tokenCountError?: string;
}

/** Build from the engine and store. Throws on a build error (previous brief stays). */
export async function rebuildBrief(opts: { trigger: 'cron' | 'manual' | 'notes'; countTokens?: boolean } = { trigger: 'manual' }): Promise<RebuildResult> {
  const timezone = await getTimezone();
  const today = todayInTimezone(timezone);
  const [firstData, hcs, sunset, profile, notes, previous] = await Promise.all([
    getSetting(SETTING_KEYS.backfillFrom),
    getSetting(SETTING_KEYS.historyCompleteSince),
    getSetting(SETTING_KEYS.disclaimerSunset),
    getOwnerProfile(),
    activeNotes(),
    currentBrief(),
  ]);
  if (!firstData) throw new Error('settings.backfill_from is not set — the brief needs a first-data date');
  const input = await loadMetricsInput({ start: firstData, end: today, timezone });
  const brief: Brief = buildBrief({
    timezone,
    today,
    input,
    firstData,
    historyCompleteSince: hcs,
    disclaimerSunset: sunset,
    profile,
    notes: notes.map((n) => ({ text: n.text, createdAt: n.createdAt.toISOString() })),
  });

  let tokens: number | null = null;
  let tokenCountError: string | undefined;
  if (opts.countTokens !== false) {
    const config = await getAnalystConfig();
    if (!config.key) tokenCountError = 'not counted — no Anthropic API key stored';
    else {
      try {
        const client = makeAnalystClient(config.key);
        const count = await client.beta.messages.countTokens({ model: config.modelDefault, system: brief.text, messages: [{ role: 'user', content: 'Count this brief.' }] });
        tokens = count.input_tokens;
      } catch (err) {
        tokenCountError = `not counted — ${describeError(err)}`;
      }
    }
  } else tokenCountError = 'not counted — skipped';

  await db.insert(analystBriefs).values({ hash: brief.hash, text: brief.text, tokens, dataThrough: brief.dataThrough });
  await setSetting(ANALYST_KEYS.briefBuiltAt, new Date().toISOString());
  const unchanged = previous?.hash === brief.hash;
  return {
    ok: true,
    hash: brief.hash,
    tokens,
    dataThrough: brief.dataThrough,
    unchanged,
    weeks: brief.weeks.length,
    reason: `brief built (${opts.trigger}) · ${brief.weeks.length} weeks · data through ${brief.dataThrough} · ${tokens !== null ? `${tokens.toLocaleString('en-US')} tokens` : tokenCountError}${unchanged ? ' · unchanged from the previous brief' : ''}`,
    ...(tokenCountError ? { tokenCountError } : {}),
  };
}

/**
 * The dispatch step: once per local day after the sources (the fairness order
 * runs it after the ingestion steps). Already built today → skipped with the
 * time; `force` rebuilds.
 */
export async function runAnalystBriefStep(opts: { force?: boolean } = {}): Promise<RebuildResult | { skipped: string }> {
  const timezone = await getTimezone();
  const today = todayInTimezone(timezone);
  const previous = await currentBrief();
  if (!opts.force && previous && localDate(previous.builtAt, timezone) === today) {
    return { skipped: `brief already built today at ${previous.builtAt.toLocaleTimeString('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false })} (${previous.tokens !== null ? `${previous.tokens.toLocaleString('en-US')} tokens` : 'tokens not counted'})` };
  }
  return rebuildBrief({ trigger: 'cron' });
}

/** "Brief built 02:10 · 21,340 tokens · data through Sep 29" for Setup and the panel. */
export function describeBrief(b: StoredBrief | null, timezone: string): string {
  if (!b) return 'The business brief hasn\'t been built yet';
  const time = b.builtAt.toLocaleTimeString('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false });
  const day = localDate(b.builtAt, timezone);
  const tokens = b.tokens !== null ? `${b.tokens.toLocaleString('en-US')} tokens` : 'tokens not counted';
  return `Brief built ${day} ${time} · ${tokens} · data through ${b.dataThrough}`;
}
