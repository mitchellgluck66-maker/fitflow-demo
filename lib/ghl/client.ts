/**
 * GoHighLevel API v2 client — READ ONLY.
 *
 * Every request funnels through `ghlRequest`, which refuses anything other
 * than GET unless ENABLE_WRITEBACK (a hard-off compile-time constant) is true.
 * That is the structural guarantee behind CLAUDE.md rule 1: no code path in
 * this app can issue a non-GET request to services.leadconnectorhq.com.
 *
 * Every response is validated with Zod at this boundary (rule 7).
 */

import type { z } from 'zod';
import {
  GHL_BASE_URL,
  GHL_API_VERSION,
  RATE_LIMIT,
  ENABLE_WRITEBACK,
  getGhlConfig,
  type GhlApiFamily,
} from './config';
import {
  GhlAppointmentSchema,
  GhlCalendarsResponseSchema,
  GhlContactResponseSchema,
  GhlEventsResponseSchema,
  GhlOpportunitySchema,
  GhlOpportunitySearchResponseSchema,
  GhlPipelinesResponseSchema,
  GhlUsersResponseSchema,
  parseMany,
  type GhlAppointment,
  type GhlCalendar,
  type GhlContact,
  type GhlOpportunity,
  type GhlPipeline,
} from './schemas';

export interface GhlRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  endpoint: string;
  family: GhlApiFamily;
  body?: Record<string, unknown>;
  query?: Record<string, string | number | boolean | undefined | null>;
}

export interface GhlResult<T = unknown> {
  ok: boolean;
  status: number;
  data: T | null;
  request: GhlRequest;
  error?: string;
  /** Set when the transport succeeded but the payload failed Zod validation. */
  validationError?: string;
  rateLimit?: { remaining?: string; dailyRemaining?: string };
}

/** Token bucket honouring GHL's 100-request / 10-second burst ceiling. */
class RateLimiter {
  private timestamps: number[] = [];
  private lastRequest = 0;

  async acquire(): Promise<void> {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < RATE_LIMIT.burstWindowMs);

    if (this.timestamps.length >= RATE_LIMIT.burstMax - 5) {
      const oldest = this.timestamps[0];
      await sleep(RATE_LIMIT.burstWindowMs - (now - oldest) + 50);
      return this.acquire();
    }

    const sinceLast = now - this.lastRequest;
    if (sinceLast < RATE_LIMIT.minIntervalMs) {
      await sleep(RATE_LIMIT.minIntervalMs - sinceLast);
    }

    this.lastRequest = Date.now();
    this.timestamps.push(this.lastRequest);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const limiter = new RateLimiter();

/** Requests actually sent this process, for sync_runs.requests_used. */
let requestCounter = 0;
export function getRequestCount(): number {
  return requestCounter;
}

export class GhlReadOnlyViolation extends Error {
  constructor(req: GhlRequest) {
    super(
      `Refused ${req.method} ${req.endpoint}: FitFlow is read-only against GoHighLevel (ENABLE_WRITEBACK is off).`,
    );
    this.name = 'GhlReadOnlyViolation';
  }
}

/**
 * Core request executor. Returns a result object rather than throwing on HTTP
 * errors, so a sync can record failures per-call without unwinding a batch.
 *
 * Throws `GhlReadOnlyViolation` synchronously (before any I/O) for a non-GET
 * request while write-back is disabled. Throwing rather than returning an
 * error is deliberate: a write attempt is a programming error, not a runtime
 * condition to be logged and moved past.
 */
export async function ghlRequest<T = unknown>(
  req: GhlRequest,
  schema?: z.ZodType<T>,
): Promise<GhlResult<T>> {
  if (req.method !== 'GET' && !ENABLE_WRITEBACK) {
    throw new GhlReadOnlyViolation(req);
  }

  const config = await getGhlConfig();
  if (!config.configured) {
    return {
      ok: false,
      status: 0,
      data: null,
      request: req,
      error: 'No GoHighLevel credentials configured. Add them in Setup or via GHL_API_TOKEN / GHL_LOCATION_ID.',
    };
  }

  const url = new URL(`${GHL_BASE_URL}${req.endpoint}`);
  if (req.query) {
    for (const [key, value] of Object.entries(req.query)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
  }

  await limiter.acquire();
  requestCounter += 1;

  try {
    const response = await fetch(url.toString(), {
      method: req.method,
      headers: {
        Authorization: `Bearer ${config.token}`,
        Version: GHL_API_VERSION[req.family],
        Accept: 'application/json',
        ...(req.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(req.body ? { body: JSON.stringify(req.body) } : {}),
    });

    const rateLimit = {
      remaining: response.headers.get('X-RateLimit-Remaining') ?? undefined,
      dailyRemaining: response.headers.get('X-RateLimit-Daily-Remaining') ?? undefined,
    };

    const text = await response.text();
    let raw: unknown = null;
    try {
      raw = text ? JSON.parse(text) : null;
    } catch {
      raw = null;
    }

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        data: null,
        request: req,
        // Never include the Authorization header or token here.
        error: `GHL ${response.status} ${req.method} ${req.endpoint}: ${text.slice(0, 300)}`,
        rateLimit,
      };
    }

    if (schema) {
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return {
          ok: false,
          status: response.status,
          data: null,
          request: req,
          error: `GHL response for ${req.endpoint} failed validation at ${issue?.path.join('.')}: ${issue?.message}`,
          validationError: parsed.error.message,
          rateLimit,
        };
      }
      return { ok: true, status: response.status, data: parsed.data, request: req, rateLimit };
    }

    return { ok: true, status: response.status, data: raw as T, request: req, rateLimit };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      data: null,
      request: req,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Pipelines
// ---------------------------------------------------------------------------

export async function listPipelines(): Promise<GhlResult<{ pipelines: GhlPipeline[] }>> {
  const config = await getGhlConfig();
  return ghlRequest(
    {
      method: 'GET',
      endpoint: '/opportunities/pipelines',
      family: 'opportunities',
      query: { locationId: config.locationId },
    },
    GhlPipelinesResponseSchema,
  );
}

// ---------------------------------------------------------------------------
// Opportunities (bulk, paged — never one search per contact)
// ---------------------------------------------------------------------------

export interface OpportunityPage {
  opportunities: GhlOpportunity[];
  rejected: number;
  warnings: string[];
  error?: string;
  requests: number;
}

/**
 * Page through every opportunity in a pipeline (or the whole location).
 *
 * The search endpoint documents `location_id` / `pipeline_id` in snake_case
 * (unlike the rest of the API). Cursor pagination via `startAfterId` +
 * `startAfter` is preferred when the response provides it; `page` otherwise.
 */
export interface OpportunityPageResult {
  opportunities: GhlOpportunity[];
  rejected: number;
  warnings: string[];
  /** True when this was the last page. */
  done: boolean;
  next: { page: number; startAfterId: string | null; startAfter: number | null };
  error?: string;
}

/**
 * ONE page of the opportunity search — the unit the resumable sync persists
 * its cursor at. `limit` is kept small (50) so a page's contact fetches fit
 * inside a serverless time budget.
 */
export async function listOpportunitiesPage(params: {
  pipelineId?: string;
  page: number;
  startAfterId?: string | null;
  startAfter?: number | null;
  limit?: number;
}): Promise<OpportunityPageResult> {
  const config = await getGhlConfig();
  const limit = params.limit ?? 50;
  const result: GhlResult<z.infer<typeof GhlOpportunitySearchResponseSchema>> = await ghlRequest(
    {
      method: 'GET',
      endpoint: '/opportunities/search',
      family: 'opportunities',
      query: {
        location_id: config.locationId,
        pipeline_id: params.pipelineId,
        limit,
        ...(params.startAfterId ? { startAfterId: params.startAfterId, startAfter: params.startAfter ?? undefined } : { page: params.page }),
      },
    },
    GhlOpportunitySearchResponseSchema,
  );
  const next = { page: params.page + 1, startAfterId: null as string | null, startAfter: null as number | null };
  if (!result.ok || !result.data) return { opportunities: [], rejected: 0, warnings: [], done: true, next, error: result.error };
  const parsed = parseMany(GhlOpportunitySchema, result.data.opportunities, 'opportunity');
  const meta = result.data.meta;
  if (meta?.startAfterId) {
    next.startAfterId = meta.startAfterId;
    next.startAfter = meta.startAfter ?? null;
  }
  return { opportunities: parsed.valid, rejected: parsed.rejected, warnings: parsed.warnings, done: result.data.opportunities.length < limit, next };
}

/**
 * Live count of OPEN opportunities in one stage — one `limit=1` search whose
 * `meta.total` is the answer. Read-only; used by nightly reconciliation.
 */
export async function countOpenOpportunities(params: { pipelineId: string; stageId: string }): Promise<{ total: number | null; error?: string }> {
  const config = await getGhlConfig();
  const result: GhlResult<z.infer<typeof GhlOpportunitySearchResponseSchema>> = await ghlRequest(
    {
      method: 'GET',
      endpoint: '/opportunities/search',
      family: 'opportunities',
      query: { location_id: config.locationId, pipeline_id: params.pipelineId, pipeline_stage_id: params.stageId, status: 'open', limit: 1, page: 1 },
    },
    GhlOpportunitySearchResponseSchema,
  );
  if (!result.ok || !result.data) return { total: null, error: result.error };
  const total = result.data.meta?.total;
  return typeof total === 'number' ? { total } : { total: null, error: 'response had no meta.total' };
}

export async function listAllOpportunities(params: {
  pipelineId?: string;
  maxPages?: number;
}): Promise<OpportunityPage> {
  const config = await getGhlConfig();
  const out: OpportunityPage = { opportunities: [], rejected: 0, warnings: [], requests: 0 };
  const maxPages = params.maxPages ?? 60; // 6,000 opportunities
  const limit = 100;

  let page = 1;
  let startAfterId: string | null = null;
  let startAfter: number | null = null;

  while (page <= maxPages) {
    const result: GhlResult<z.infer<typeof GhlOpportunitySearchResponseSchema>> = await ghlRequest(
      {
        method: 'GET',
        endpoint: '/opportunities/search',
        family: 'opportunities',
        query: {
          location_id: config.locationId,
          pipeline_id: params.pipelineId,
          limit,
          ...(startAfterId ? { startAfterId, startAfter } : { page }),
        },
      },
      GhlOpportunitySearchResponseSchema,
    );
    out.requests += 1;

    if (!result.ok || !result.data) {
      out.error = result.error;
      return out;
    }

    const parsed = parseMany(GhlOpportunitySchema, result.data.opportunities, 'opportunity');
    out.opportunities.push(...parsed.valid);
    out.rejected += parsed.rejected;
    out.warnings.push(...parsed.warnings);

    if (result.data.opportunities.length < limit) break;

    const meta = result.data.meta;
    if (meta?.startAfterId) {
      startAfterId = meta.startAfterId;
      startAfter = meta.startAfter ?? null;
    }
    page += 1;
  }

  if (page > maxPages) {
    out.warnings.push(`Opportunity paging stopped at ${maxPages} pages — raise maxPages if this is real.`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Calendars & appointments
// ---------------------------------------------------------------------------

export async function listCalendars(): Promise<GhlResult<{ calendars: GhlCalendar[] }>> {
  const config = await getGhlConfig();
  return ghlRequest(
    {
      method: 'GET',
      endpoint: '/calendars/',
      family: 'calendars',
      query: { locationId: config.locationId },
    },
    GhlCalendarsResponseSchema,
  );
}

/**
 * Appointments in an absolute window (epoch ms). Callers compute the window in
 * the business timezone (lib/day.ts) — never assume UTC midnight.
 */
export async function listAppointments(params: {
  startTimeMs: number;
  endTimeMs: number;
  calendarId: string;
}): Promise<{ events: GhlAppointment[]; rejected: number; warnings: string[]; error?: string }> {
  const config = await getGhlConfig();
  const result = await ghlRequest(
    {
      method: 'GET',
      endpoint: '/calendars/events',
      family: 'calendars',
      query: {
        locationId: config.locationId,
        startTime: params.startTimeMs,
        endTime: params.endTimeMs,
        calendarId: params.calendarId,
      },
    },
    GhlEventsResponseSchema,
  );

  if (!result.ok || !result.data) {
    return { events: [], rejected: 0, warnings: [], error: result.error };
  }
  const parsed = parseMany(GhlAppointmentSchema, result.data.events, 'appointment');
  return { events: parsed.valid, rejected: parsed.rejected, warnings: parsed.warnings };
}

// ---------------------------------------------------------------------------
// Contacts & users
// ---------------------------------------------------------------------------

export async function getContact(contactId: string): Promise<GhlResult<{ contact: GhlContact }>> {
  return ghlRequest(
    { method: 'GET', endpoint: `/contacts/${contactId}`, family: 'contacts' },
    GhlContactResponseSchema,
  );
}

export async function listUsers(): Promise<
  GhlResult<{ users: Array<{ id: string; name?: string | null; firstName?: string | null; lastName?: string | null; email?: string | null }> }>
> {
  const config = await getGhlConfig();
  return ghlRequest(
    { method: 'GET', endpoint: '/users/', family: 'users', query: { locationId: config.locationId } },
    GhlUsersResponseSchema,
  );
}

/** Connectivity check for Setup: one cheap read. */
export async function testConnection(): Promise<{
  ok: boolean;
  configured: boolean;
  message: string;
  pipelineCount?: number;
}> {
  const config = await getGhlConfig();
  if (!config.configured) {
    return {
      ok: false,
      configured: false,
      message: 'No credentials set. Add a Private Integration Token and Location ID in Setup.',
    };
  }
  const result = await listPipelines();
  if (!result.ok) {
    return { ok: false, configured: true, message: result.error ?? 'Connection failed' };
  }
  return {
    ok: true,
    configured: true,
    message: 'Connected to GoHighLevel (read-only).',
    pipelineCount: result.data?.pipelines.length ?? 0,
  };
}
