/**
 * Companion stage 5, item 4 — the outcome-log audit. READ-ONLY: the database only, no GoHighLevel call, no write.
 *
 *   npm run companion:audit -- --days 7          # every companion_actions row of the last 7 days (default)
 *   npm run companion:audit -- --days 30 --json  # the same as JSON lines
 *
 * Lists every action with each step's request and flags:
 *   (a) SAME-STAGE PUT          a stage PUT whose pipelineStageId equals before.stageId (Bridget Voigt, 2026-10-30) —
 *                               a same-stage re-save can re-fire GHL stage workflows;
 *   (b) APPOINTMENT CANCELLED   an appointment step set to cancelled (Sindhu Gollamudi, 2026-10-30 — GHL emailed her);
 *   (c) BACKWARD MOVE           after.stageId sits earlier in the pipeline order than before.stageId.
 * A request that was never sent (dry run, pending behind a failed step) is listed as "planned, not sent" and flagged
 * the same way, marked (not sent). Exit 0 always — an audit lists, it does not gate.
 */

import { asc, gte, inArray } from 'drizzle-orm';
import { db, companionActions, stages, type CompanionAction, type CompanionStepName, type CompanionStepRecord } from '../db';
import { getTimezone } from '../lib/settings';

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

export type AuditFlagKind = 'same_stage_put' | 'appointment_cancelled' | 'backward_move';
export interface AuditFlag {
  kind: AuditFlagKind;
  label: string;
  sent: boolean;
  detail: string;
}

/** Pure: the flags for one row, given the stage positions of its pipeline. */
export function auditFlags(row: Pick<CompanionAction, 'before' | 'after' | 'steps' | 'outcomeKey' | 'state'>, positions: Map<string, number>): AuditFlag[] {
  const flags: AuditFlag[] = [];
  const sentStatus = (r: CompanionStepRecord | undefined) => r?.status === 'ok' || r?.status === 'failed';
  const stage = row.steps.stage;
  const stageBody = stage?.request?.body as { pipelineStageId?: string } | undefined;
  if (stage?.request && stageBody?.pipelineStageId && stageBody.pipelineStageId === row.before.stageId) {
    flags.push({ kind: 'same_stage_put', label: 'SAME-STAGE PUT', sent: sentStatus(stage), detail: `PUT ${stage.request.path} pipelineStageId=${stageBody.pipelineStageId} while before.stageId was the same (${row.before.stageName ?? '?'})` });
  }
  const appt = row.steps.appointment;
  const apptBody = appt?.request?.body as { appointmentStatus?: string } | undefined;
  if (appt?.request && apptBody?.appointmentStatus === 'cancelled') {
    flags.push({ kind: 'appointment_cancelled', label: 'APPOINTMENT CANCELLED', sent: sentStatus(appt), detail: `PUT ${appt.request.path} appointmentStatus=cancelled (was ${row.before.appointmentStatus ?? '?'})` });
  }
  if (stage?.request && row.before.stageId && row.after.stageId && row.before.stageId !== row.after.stageId) {
    const from = positions.get(row.before.stageId);
    const to = positions.get(row.after.stageId);
    if (from !== undefined && to !== undefined && to < from) {
      flags.push({ kind: 'backward_move', label: 'BACKWARD MOVE', sent: sentStatus(stage), detail: `${row.before.stageName ?? row.before.stageId} (position ${from}) → ${row.after.stageName ?? row.after.stageId} (position ${to})${row.outcomeKey === 'move_to' ? ' via Move to…' : ' via a mapped outcome'}` });
    }
  }
  return flags;
}

function fmtStep(name: CompanionStepName, r: CompanionStepRecord | undefined): string {
  if (!r) return `    ${name.padEnd(11)} —`;
  const req = r.request ? `${r.request.method} ${r.request.path} ${JSON.stringify(r.request.body)}` : '(no request)';
  const tail = r.status === 'skipped' ? `skipped — ${r.reason ?? ''}` : r.status === 'dry_run' ? 'dry run — not sent' : r.status === 'pending' ? 'pending — not sent' : `${r.status}${r.httpStatus ? ` HTTP ${r.httpStatus}` : ''}${r.error ? ` — ${r.error}` : ''}`;
  return `    ${name.padEnd(11)} ${tail.padEnd(44)} ${req}`;
}

async function main() {
  const days = Math.max(1, Number(arg('days') ?? 7));
  const json = process.argv.includes('--json');
  const tz = await getTimezone();
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await db.select().from(companionActions).where(gte(companionActions.createdAt, since)).orderBy(asc(companionActions.createdAt));
  const pipelineIds = Array.from(new Set(rows.map((r) => r.pipelineId).filter((p): p is string => Boolean(p))));
  const stageRows = pipelineIds.length ? await db.select({ id: stages.id, pipelineId: stages.pipelineId, position: stages.position }).from(stages).where(inArray(stages.pipelineId, pipelineIds)) : [];
  const positionsByPipeline = new Map<string, Map<string, number>>();
  for (const s of stageRows) {
    if (s.position === null) continue;
    if (!positionsByPipeline.has(s.pipelineId)) positionsByPipeline.set(s.pipelineId, new Map());
    positionsByPipeline.get(s.pipelineId)!.set(s.id, s.position);
  }
  const when = (d: Date) => `${d.toLocaleString('en-US', { timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })} ${tz}`;

  let flagged = 0;
  const counts: Record<AuditFlagKind, number> = { same_stage_put: 0, appointment_cancelled: 0, backward_move: 0 };
  console.log(`Companion audit · last ${days} day(s) since ${since.toISOString()} · ${rows.length} action(s) · read-only`);
  for (const r of rows) {
    const flags = auditFlags(r, positionsByPipeline.get(r.pipelineId ?? '') ?? new Map());
    if (flags.length) flagged++;
    for (const f of flags) counts[f.kind]++;
    if (json) {
      console.log(JSON.stringify({ id: r.id, createdAt: r.createdAt.toISOString(), user: r.userName, client: r.clientName, callType: r.callType, outcome: r.outcomeKey, state: r.state, dryRun: r.dryRun, undoneAt: r.undoneAt, before: r.before, after: r.after, steps: r.steps, flags }));
      continue;
    }
    const head = `${when(r.createdAt)} · ${r.userName} · ${r.clientName} · ${r.callType} · ${r.label} (${r.outcomeKey}) · ${r.state}${r.dryRun ? ' · DRY RUN' : ''}${r.undoneAt ? ` · undone ${when(r.undoneAt)}` : ''}`;
    console.log(`\n${flags.length ? '⚑ ' : '  '}${head}`);
    console.log(`    before ${r.before.stageName ?? '—'} / ${r.before.status ?? '—'} / appt ${r.before.appointmentStatus ?? '—'}  →  after ${r.after.stageName ?? '—'} / ${r.after.status ?? '—'} / appt ${r.after.appointmentStatus ?? '—'}`);
    for (const name of ['stage', 'appointment', 'note'] as const) console.log(fmtStep(name, r.steps[name]));
    for (const f of flags) console.log(`    ⚑ ${f.label}${f.sent ? '' : ' (planned, not sent)'} — ${f.detail}`);
  }
  console.log(`\n${rows.length} action(s), ${flagged} flagged · same-stage PUT ${counts.same_stage_put} · appointment cancelled ${counts.appointment_cancelled} · backward move ${counts.backward_move}`);
  process.exit(0);
}

if (process.argv[1]?.endsWith('companion-audit.ts')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
