/**
 * The one way client components call FitFlow's own API (2026-09-30, audit P1 #1).
 *
 * `fetch` rejects with the bare "Failed to fetch" when the server never answers, and several
 * components swallowed that and stayed on a skeleton forever. `fetchJson` gives every failure a
 * sentence the owner can act on, gives up after `timeoutMs` (a route that hangs is a failure, not a
 * long load), and reads the API's own `error` / `detail` on a non-2xx status.
 */
export class FetchJsonError extends Error {
  readonly status: number | null;
  readonly kind: 'network' | 'timeout' | 'http' | 'parse';
  constructor(message: string, kind: FetchJsonError['kind'], status: number | null = null) {
    super(message);
    this.name = 'FetchJsonError';
    this.kind = kind;
    this.status = status;
  }
}

export const FETCH_TIMEOUT_MS = 45_000;

/** A sentence for a fetch failure — never the bare "Failed to fetch". */
export function describeFetchFailure(error: unknown, url: string, timeoutMs = FETCH_TIMEOUT_MS): FetchJsonError {
  if (error instanceof FetchJsonError) return error;
  const path = url.split('?')[0];
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new FetchJsonError(`${path} did not answer within ${Math.round(timeoutMs / 1000)} s.`, 'timeout');
  }
  if (error instanceof TypeError) {
    return new FetchJsonError(`Could not reach FitFlow's server for ${path} — the request failed before a response arrived (offline, or the server did not answer).`, 'network');
  }
  return new FetchJsonError(error instanceof Error ? error.message : String(error), 'network');
}

export async function fetchJson<T>(url: string, init: RequestInit = {}, opts: { timeoutMs?: number } = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const outer = init.signal;
  outer?.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      if (res.ok) throw new FetchJsonError(`${url.split('?')[0]} returned something that was not JSON (HTTP ${res.status}).`, 'parse', res.status);
    }
    if (!res.ok) {
      const b = (body ?? {}) as { error?: string; detail?: string };
      const text = b.error ? (b.detail && b.detail !== b.error ? `${b.error} — ${b.detail}` : b.error) : `HTTP ${res.status}`;
      throw new FetchJsonError(text, 'http', res.status);
    }
    return body as T;
  } catch (error) {
    throw describeFetchFailure(error, url, timeoutMs);
  } finally {
    clearTimeout(timer);
  }
}
