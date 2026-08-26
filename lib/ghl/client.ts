/**
 * GoHighLevel API v2 client.
 *
 * Every method here is wired against the real documented endpoints. When the
 * integration is in dry-run mode (no token, or GHL_DRY_RUN != 'false') the
 * request is constructed in full and returned as a description instead of being
 * sent. That means the mapping logic is exercised identically in both modes -
 * going live is a config change, not a code change.
 */

import {
  GHL_BASE_URL,
  GHL_API_VERSION,
  RATE_LIMIT,
  getGhlConfig,
  type GhlApiFamily,
} from './config';
import {
  GhlApiError,
  type GhlAppointment,
  type GhlAppointmentStatus,
  type GhlCalendar,
  type GhlOpportunity,
  type GhlOpportunityStatus,
  type GhlPipeline,
} from './types';

export interface GhlRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  endpoint: string;
  family: GhlApiFamily;
  body?: Record<string, unknown>;
  query?: Record<string, string | number | boolean | undefined>;
}

export interface GhlResult<T = unknown> {
  ok: boolean;
  dryRun: boolean;
  status: number;
  data: T | null;
  /** The exact request that was (or would have been) sent. */
  request: GhlRequest;
  error?: string;
  rateLimit?: {
    remaining?: string;
    dailyRemaining?: string;
  };
}

/**
 * Token bucket honouring GHL's 100-request / 10-second burst ceiling.
 * A naive "fetch every appointment then hydrate each contact" loop will trip
 * that limit, so all traffic funnels through here.
 */
class RateLimiter {
  private timestamps: number[] = [];
  private lastRequest = 0;

  async acquire(): Promise<void> {
    const now = Date.now();
    this.timestamps = this.timestamps.filter(
      (t) => now - t < RATE_LIMIT.burstWindowMs,
    );

    if (this.timestamps.length >= RATE_LIMIT.burstMax - 5) {
      const oldest = this.timestamps[0];
      const waitMs = RATE_LIMIT.burstWindowMs - (now - oldest) + 50;
      await sleep(waitMs);
      return this.acquire();
    }

    // Gentle spacing so a batch never looks like a spike.
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

/** Core request executor. Returns a result object rather than throwing, so the
 *  sync queue can record failures per-row without unwinding a whole batch. */
export async function ghlRequest<T = unknown>(
  req: GhlRequest,
): Promise<GhlResult<T>> {
  const config = await getGhlConfig();

  const url = new URL(`${GHL_BASE_URL}${req.endpoint}`);
  if (req.query) {
    for (const [key, value] of Object.entries(req.query)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  // DRY RUN: build everything, send nothing.
  if (config.dryRun) {
    return {
      ok: true,
      dryRun: true,
      status: 0,
      data: null,
      request: req,
      error: config.configured
        ? 'Dry run enabled (set GHL_DRY_RUN=false to send)'
        : 'No GHL credentials configured - running in dry-run mode',
    };
  }

  await limiter.acquire();

  try {
    const response = await fetch(url.toString(), {
      method: req.method,
      headers: {
        Authorization: `Bearer ${config.token}`,
        Version: GHL_API_VERSION[req.family],
        Accept: 'application/json',
        ...(req.body ? { 'Content-Type': 'application/json' } : {}),
      },
      // Note: GHL's tag-removal endpoint is a DELETE that carries a JSON body.
      // Undici (Node's fetch) sends it correctly; some older clients drop it.
      ...(req.body ? { body: JSON.stringify(req.body) } : {}),
    });

    const rateLimit = {
      remaining: response.headers.get('X-RateLimit-Remaining') ?? undefined,
      dailyRemaining:
        response.headers.get('X-RateLimit-Daily-Remaining') ?? undefined,
    };

    const text = await response.text();
    let data: T | null = null;
    try {
      data = text ? (JSON.parse(text) as T) : null;
    } catch {
      data = null;
    }

    if (!response.ok) {
      return {
        ok: false,
        dryRun: false,
        status: response.status,
        data,
        request: req,
        error: `GHL ${response.status}: ${text.slice(0, 500)}`,
        rateLimit,
      };
    }

    return {
      ok: true,
      dryRun: false,
      status: response.status,
      data,
      request: req,
      rateLimit,
    };
  } catch (err) {
    return {
      ok: false,
      dryRun: false,
      status: 0,
      data: null,
      request: req,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Calendars & appointments
// ---------------------------------------------------------------------------

/**
 * List appointments in a window.
 *
 * The query is timezone-agnostic - startTime/endTime are epoch milliseconds,
 * i.e. absolute instants. Callers must compute the local business day boundary
 * themselves (see lib/day.ts) rather than assuming UTC midnight.
 *
 * One of calendarId / userId / groupId is required alongside locationId.
 */
export async function listAppointments(params: {
  startTimeMs: number;
  endTimeMs: number;
  calendarId?: string;
  userId?: string;
  groupId?: string;
}): Promise<GhlResult<{ events: GhlAppointment[] }>> {
  const config = await getGhlConfig();
  return ghlRequest<{ events: GhlAppointment[] }>({
    method: 'GET',
    endpoint: '/calendars/events',
    family: 'calendars',
    query: {
      locationId: config.locationId ?? '',
      startTime: params.startTimeMs,
      endTime: params.endTimeMs,
      calendarId: params.calendarId,
      userId: params.userId,
      groupId: params.groupId,
    },
  });
}

export async function getAppointment(
  eventId: string,
): Promise<GhlResult<{ event: GhlAppointment }>> {
  return ghlRequest<{ event: GhlAppointment }>({
    method: 'GET',
    endpoint: `/calendars/events/appointments/${eventId}`,
    family: 'calendars',
  });
}

/**
 * Update an appointment's attendance status.
 *
 * Sends the MINIMAL body - only the fields we intend to change. Round-tripping a
 * fetched appointment object risks clobbering fields we never meant to touch.
 *
 * `toNotify` is set explicitly rather than left to the default: marking someone
 * a no-show should not blast them with whatever automation is wired to the
 * status change unless that is deliberately switched on.
 */
export async function updateAppointmentStatus(
  eventId: string,
  status: GhlAppointmentStatus,
): Promise<GhlResult> {
  const config = await getGhlConfig();
  return ghlRequest({
    method: 'PUT',
    endpoint: `/calendars/events/appointments/${eventId}`,
    family: 'calendars',
    body: {
      appointmentStatus: status,
      toNotify: config.notifyOnWrite,
    },
  });
}

export async function listCalendars(): Promise<GhlResult<{ calendars: GhlCalendar[] }>> {
  const config = await getGhlConfig();
  return ghlRequest<{ calendars: GhlCalendar[] }>({
    method: 'GET',
    endpoint: '/calendars/',
    family: 'calendars',
    query: { locationId: config.locationId ?? '' },
  });
}

/**
 * Attach a note to the specific appointment. Preferred over a contact note for
 * attendance rationale because it stays scoped to the session it describes.
 */
export async function createAppointmentNote(
  appointmentId: string,
  body: string,
  userId?: string,
): Promise<GhlResult> {
  return ghlRequest({
    method: 'POST',
    endpoint: `/calendars/appointments/${appointmentId}/notes`,
    family: 'calendars',
    body: { body, ...(userId ? { userId } : {}) },
  });
}

// ---------------------------------------------------------------------------
// Opportunities & pipelines
// ---------------------------------------------------------------------------

export async function listPipelines(): Promise<GhlResult<{ pipelines: GhlPipeline[] }>> {
  const config = await getGhlConfig();
  return ghlRequest<{ pipelines: GhlPipeline[] }>({
    method: 'GET',
    endpoint: '/opportunities/pipelines',
    family: 'opportunities',
    query: { locationId: config.locationId ?? '' },
  });
}

/**
 * Move an opportunity to a different pipeline stage.
 * Both pipelineId and pipelineStageId are sent - stage ids are UUIDs and are
 * only meaningful within their pipeline.
 */
export async function updateOpportunityStage(
  opportunityId: string,
  pipelineId: string,
  pipelineStageId: string,
): Promise<GhlResult> {
  return ghlRequest({
    method: 'PUT',
    endpoint: `/opportunities/${opportunityId}`,
    family: 'opportunities',
    body: { pipelineId, pipelineStageId },
  });
}

/** Dedicated status endpoint - preferred over the general update for won/lost. */
export async function updateOpportunityStatus(
  opportunityId: string,
  status: GhlOpportunityStatus,
  lostReasonId?: string,
): Promise<GhlResult> {
  return ghlRequest({
    method: 'PUT',
    endpoint: `/opportunities/${opportunityId}/status`,
    family: 'opportunities',
    body: { status, ...(lostReasonId ? { lostReasonId } : {}) },
  });
}

export async function searchOpportunities(params: {
  contactId?: string;
  pipelineId?: string;
  limit?: number;
}): Promise<GhlResult<{ opportunities: GhlOpportunity[] }>> {
  const config = await getGhlConfig();
  return ghlRequest<{ opportunities: GhlOpportunity[] }>({
    method: 'GET',
    endpoint: '/opportunities/search',
    family: 'opportunities',
    query: {
      locationId: config.locationId ?? '',
      contactId: params.contactId,
      pipelineId: params.pipelineId,
      limit: params.limit ?? 100, // max is 100
    },
  });
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

/**
 * Add tags to a contact.
 *
 * IMPORTANT: we use the dedicated tag endpoint, never `tags` on PUT /contacts.
 * A `tags` array in a contact update REPLACES the entire tag set rather than
 * merging, which would silently wipe tags set by other systems.
 */
export async function addContactTags(
  contactId: string,
  tags: string[],
): Promise<GhlResult> {
  return ghlRequest({
    method: 'POST',
    endpoint: `/contacts/${contactId}/tags`,
    family: 'contacts',
    body: { tags },
  });
}

export async function removeContactTags(
  contactId: string,
  tags: string[],
): Promise<GhlResult> {
  return ghlRequest({
    method: 'DELETE',
    endpoint: `/contacts/${contactId}/tags`,
    family: 'contacts',
    body: { tags },
  });
}

export async function createContactNote(
  contactId: string,
  body: string,
  userId?: string,
): Promise<GhlResult> {
  return ghlRequest({
    method: 'POST',
    endpoint: `/contacts/${contactId}/notes`,
    family: 'contacts',
    body: { body, ...(userId ? { userId } : {}) },
  });
}

/**
 * Fetch a single contact.
 *
 * The response shape is only partially documented - notably the attribution
 * field names could not be confirmed - so callers should treat anything beyond
 * the core identity fields as best-effort and never write them back.
 */
export async function getContact(
  contactId: string,
): Promise<GhlResult<{ contact: Record<string, unknown> }>> {
  return ghlRequest<{ contact: Record<string, unknown> }>({
    method: 'GET',
    endpoint: `/contacts/${contactId}`,
    family: 'contacts',
  });
}

/** Staff list, used to map GHL user ids to human names on appointments. */
export async function listUsers(): Promise<
  GhlResult<{ users: Array<{ id: string; name?: string; email?: string }> }>
> {
  const config = await getGhlConfig();
  return ghlRequest<{ users: Array<{ id: string; name?: string; email?: string }> }>({
    method: 'GET',
    endpoint: '/users/',
    family: 'users',
    query: { locationId: config.locationId ?? '' },
  });
}

/**
 * Page through every opportunity in a pipeline.
 *
 * Deliberately bulk rather than one search per contact: an import of 300
 * appointments would otherwise fire 300 searches and trip the 100-request /
 * 10-second burst ceiling. Three paged calls cover the same ground.
 */
export async function listAllOpportunities(
  pipelineId?: string,
): Promise<{ opportunities: GhlOpportunity[]; error?: string }> {
  const config = await getGhlConfig();
  const collected: GhlOpportunity[] = [];
  let page = 1;
  const MAX_PAGES = 40; // 4,000 opportunities - well beyond a single location

  while (page <= MAX_PAGES) {
    const result = await ghlRequest<{ opportunities: GhlOpportunity[] }>({
      method: 'GET',
      endpoint: '/opportunities/search',
      family: 'opportunities',
      query: {
        locationId: config.locationId ?? '',
        pipelineId,
        limit: 100, // documented maximum
        page,
      },
    });

    if (!result.ok) {
      return { opportunities: collected, error: result.error };
    }

    const batch = result.data?.opportunities ?? [];
    collected.push(...batch);

    // A short page means we've reached the end.
    if (batch.length < 100) break;
    page += 1;
  }

  return { opportunities: collected };
}

/**
 * Connectivity check used by the Settings page.
 * Hits a cheap read endpoint to confirm the token, location id and scopes work.
 */
export async function testConnection(): Promise<{
  ok: boolean;
  dryRun: boolean;
  message: string;
  calendarCount?: number;
}> {
  const config = await getGhlConfig();

  if (!config.configured) {
    return {
      ok: false,
      dryRun: true,
      message:
        'No credentials set. Add GHL_API_TOKEN and GHL_LOCATION_ID to .env.local.',
    };
  }

  if (config.dryRun) {
    return {
      ok: true,
      dryRun: true,
      message:
        'Credentials present but dry-run is on. Set GHL_DRY_RUN=false to send live writes.',
    };
  }

  const result = await listCalendars();
  if (!result.ok) {
    return { ok: false, dryRun: false, message: result.error ?? 'Connection failed' };
  }

  return {
    ok: true,
    dryRun: false,
    message: 'Connected to GoHighLevel.',
    calendarCount: result.data?.calendars?.length ?? 0,
  };
}

export { GhlApiError };
