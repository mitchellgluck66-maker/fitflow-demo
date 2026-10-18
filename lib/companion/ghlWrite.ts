/**
 * Companion stage 2 — THE ONLY module that can send a non-GET request to GoHighLevel.
 *
 * CLAUDE.md rule 1 (amended 2026-10-18): the dashboard, the syncs and every other feature stay read-only through
 * `lib/ghl/client#ghlRequest`, which throws on any non-GET while `ENABLE_WRITEBACK` is the literal `false`. The
 * Companion's outcome log is the one sanctioned write path, and it is boxed in three ways:
 *
 *   1. Its OWN key — `settings.ghl_companion_write_token` (sealed at rest). The read key is never sent from here;
 *      the write key is never read anywhere else.
 *   2. An allow-list of EXACTLY three calls (`WRITE_ALLOW_LIST`). `assertAllowed` runs before any I/O and throws
 *      `CompanionWriteRefused` for anything else — another path, another method, a query string, a `..`.
 *   3. Typed builders — `updateOpportunity`, `updateAppointmentStatus`, `addContactNote` — are the only way a body
 *      is made, and each validates its input with Zod.
 *
 * `scripts/verify-readonly.sh` proves (steps 6–8) that no non-GET to GHL exists outside this file and that this
 * file's paths are the three above. `verifyWriteToken` is the module's one GET: a read probe with the write key,
 * for the Setup Verify button; GHL offers no scope introspection, so the write scopes are proven only by
 * `npm run companion:live-test`.
 */

import { z } from 'zod';
import { GHL_BASE_URL, GHL_API_VERSION, getGhlConfig, maskToken, type GhlApiFamily } from '../ghl/config';
import { GhlAppointmentStatusSchema, GhlOpportunityStatusSchema, GhlPipelinesResponseSchema, type GhlAppointmentStatus, type GhlOpportunityStatus } from '../ghl/schemas';
import { getSetting } from '../settings';
import { COMPANION_SETTING_KEYS } from './config';

export type WriteMethod = 'PUT' | 'POST';

export interface AllowedWrite {
  name: 'update_opportunity' | 'update_appointment_status' | 'add_contact_note';
  method: WriteMethod;
  pattern: RegExp;
  family: GhlApiFamily;
}

const ID = '[A-Za-z0-9_-]{1,64}';

/** Exactly three. Adding a fourth is a design change that needs Mitchell's explicit go (CLAUDE.md rule 1). */
export const WRITE_ALLOW_LIST: readonly AllowedWrite[] = [
  { name: 'update_opportunity', method: 'PUT', pattern: new RegExp(`^/opportunities/${ID}$`), family: 'opportunities' },
  { name: 'update_appointment_status', method: 'PUT', pattern: new RegExp(`^/calendars/events/appointments/${ID}$`), family: 'calendars' },
  { name: 'add_contact_note', method: 'POST', pattern: new RegExp(`^/contacts/${ID}/notes$`), family: 'contacts' },
] as const;

/** The HTTP method of an allow-listed call, so no other module ever names one. */
export function methodOf(name: AllowedWrite['name']): WriteMethod {
  return WRITE_ALLOW_LIST.find((a) => a.name === name)!.method;
}

export class CompanionWriteRefused extends Error {
  constructor(method: string, path: string, reason = 'not in the Companion write allow-list') {
    super(`Refused ${method} ${path}: ${reason}`);
    this.name = 'CompanionWriteRefused';
  }
}

/** Pure. Throws before any I/O for anything but the three allow-listed calls. */
export function assertAllowed(method: string, path: string): AllowedWrite {
  if (typeof path !== 'string' || path.includes('?') || path.includes('#') || path.includes('..') || !path.startsWith('/')) {
    throw new CompanionWriteRefused(method, String(path));
  }
  const hit = WRITE_ALLOW_LIST.find((a) => a.method === method && a.pattern.test(path));
  if (!hit) throw new CompanionWriteRefused(method, path);
  return hit;
}

export interface WriteRequest {
  method: WriteMethod;
  path: string;
  body: Record<string, unknown>;
}

export interface WriteResult {
  status: 'ok' | 'failed' | 'dry_run';
  name: AllowedWrite['name'];
  httpStatus: number | null;
  /** The response text, ≤ 2 KB (never the token). */
  body: string | null;
  error?: string;
  request: WriteRequest;
  at: string;
}

export type Transport = (url: string, init: RequestInit) => Promise<Response>;

/** Scripts (the live test's forced failure) and tests can replace the transport; `null` = global fetch. */
let transportOverride: Transport | null = null;
export function setCompanionWriteTransport(t: Transport | null): void {
  transportOverride = t;
}

/** Writes sent this process (not dry runs), for the live test's summary. */
let writeCounter = 0;
export function getCompanionWriteCount(): number {
  return writeCounter;
}

export const NO_WRITE_KEY_MESSAGE = 'No Companion write key — the owner adds it in Setup → Companion.';
const BODY_LIMIT = 2048;

async function writeToken(): Promise<string | null> {
  const t = await getSetting(COMPANION_SETTING_KEYS.writeToken);
  return t?.trim() || null;
}

export async function hasWriteKey(): Promise<boolean> {
  return (await writeToken()) !== null;
}

export async function getCompanionWriteConfig(): Promise<{ configured: boolean; preview: string | null }> {
  const t = await writeToken();
  return { configured: t !== null, preview: maskToken(t) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The one executor. Order of operations is the guarantee: allow-list → dry run → key → network.
 * Never throws for an HTTP problem (the orchestrator records it per step); throws only for a refused call.
 */
export async function companionWrite(req: WriteRequest, opts: { dryRun: boolean }): Promise<WriteResult> {
  const allowed = assertAllowed(req.method, req.path);
  const at = new Date().toISOString();
  const request: WriteRequest = { method: req.method, path: req.path, body: req.body };
  if (opts.dryRun) return { status: 'dry_run', name: allowed.name, httpStatus: null, body: null, request, at };

  const token = await writeToken();
  if (!token) return { status: 'failed', name: allowed.name, httpStatus: null, body: null, error: NO_WRITE_KEY_MESSAGE, request, at };

  const send = async () => {
    writeCounter += 1;
    const transport = transportOverride ?? ((url, init) => fetch(url, init));
    return transport(`${GHL_BASE_URL}${req.path}`, {
      method: req.method,
      headers: { Authorization: `Bearer ${token}`, Version: GHL_API_VERSION[allowed.family], Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });
  };

  try {
    let response = await send();
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('Retry-After'));
      await sleep(Math.min(10_000, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2_000));
      response = await send();
    }
    const text = (await response.text()).slice(0, BODY_LIMIT);
    if (!response.ok) {
      return { status: 'failed', name: allowed.name, httpStatus: response.status, body: text, error: `GHL ${response.status} ${req.method} ${req.path}: ${text.slice(0, 300)}`, request, at };
    }
    return { status: 'ok', name: allowed.name, httpStatus: response.status, body: text, request, at };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 'failed', name: allowed.name, httpStatus: null, body: null, error: `${req.method} ${req.path}: ${message.split(token).join('[token]')}`, request, at };
  }
}

// ---- the three typed builders ---------------------------------------------------------------------------------

const IdSchema = z.string().regex(new RegExp(`^${ID}$`), 'a GoHighLevel id');
const OpportunityPatchSchema = z
  .object({ pipelineId: IdSchema, pipelineStageId: IdSchema.optional(), status: GhlOpportunityStatusSchema.optional() })
  .refine((p) => p.pipelineStageId !== undefined || p.status !== undefined, { message: 'nothing to change' });

/** PUT /opportunities/{id} — stage and/or status (GHL requires pipelineId in the body). */
export async function updateOpportunity(id: string, patch: { pipelineId: string; pipelineStageId?: string; status?: GhlOpportunityStatus }, opts: { dryRun: boolean }): Promise<WriteResult> {
  const oppId = IdSchema.parse(id);
  const body = OpportunityPatchSchema.parse(patch);
  return companionWrite({ method: 'PUT', path: `/opportunities/${oppId}`, body }, opts);
}

/** PUT /calendars/events/appointments/{eventId} — the appointment status (GHL's enum, lowercase, `noshow` one word). */
export async function updateAppointmentStatus(eventId: string, status: GhlAppointmentStatus, opts: { dryRun: boolean }): Promise<WriteResult> {
  const id = IdSchema.parse(eventId);
  const appointmentStatus = GhlAppointmentStatusSchema.parse(status);
  return companionWrite({ method: 'PUT', path: `/calendars/events/appointments/${id}`, body: { appointmentStatus } }, opts);
}

/** POST /contacts/{contactId}/notes — the audit note, attributed to the GHL user when the login carries one. */
export async function addContactNote(contactId: string, body: string, userId: string | null, opts: { dryRun: boolean }): Promise<WriteResult> {
  const id = IdSchema.parse(contactId);
  const text = z.string().min(1).max(5000).parse(body);
  const user = userId ? IdSchema.parse(userId) : null;
  return companionWrite({ method: 'POST', path: `/contacts/${id}/notes`, body: { body: text, ...(user ? { userId: user } : {}) } }, opts);
}

// ---- the one read: the Setup Verify probe ---------------------------------------------------------------------

/**
 * One GET /opportunities/pipelines with the WRITE key through this module's transport: proves the key authenticates
 * to the configured location. Write scopes cannot be read back from GHL — the card says so and names the live test.
 */
export async function verifyWriteToken(): Promise<{ ok: boolean; message: string; pipelineCount?: number }> {
  const token = await writeToken();
  if (!token) return { ok: false, message: NO_WRITE_KEY_MESSAGE };
  const config = await getGhlConfig();
  if (!config.locationId) return { ok: false, message: 'No GoHighLevel Location ID is set (Setup → GoHighLevel).' };
  const url = new URL(`${GHL_BASE_URL}/opportunities/pipelines`);
  url.searchParams.set('locationId', config.locationId);
  try {
    const transport = transportOverride ?? ((u, init) => fetch(u, init));
    const response = await transport(url.toString(), { method: 'GET', headers: { Authorization: `Bearer ${token}`, Version: GHL_API_VERSION.opportunities, Accept: 'application/json' } });
    const text = await response.text();
    if (!response.ok) return { ok: false, message: `Verification failed: GHL ${response.status} GET /opportunities/pipelines: ${text.slice(0, 200)}` };
    const parsed = GhlPipelinesResponseSchema.safeParse(text ? JSON.parse(text) : null);
    if (!parsed.success) return { ok: false, message: 'Verification failed: the pipelines response did not match the expected shape.' };
    return { ok: true, message: `Write key accepted for location ${config.locationId} (${parsed.data.pipelines.length} pipelines readable). Write scopes are proven only by npm run companion:live-test.`, pipelineCount: parsed.data.pipelines.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `Verification failed: ${message.split(token).join('[token]')}` };
  }
}
