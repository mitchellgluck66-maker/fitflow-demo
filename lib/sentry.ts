/**
 * Optional Sentry error capture. When SENTRY_DSN is unset this is a no-op;
 * when set, a minimal event is POSTed to Sentry's store endpoint with a
 * short timeout. Never throws, never blocks a sync.
 */

interface ParsedDsn {
  endpoint: string;
  publicKey: string;
}

export function parseDsn(dsn: string): ParsedDsn | null {
  try {
    const u = new URL(dsn);
    const projectId = u.pathname.replace(/^\//, '');
    if (!u.username || !projectId) return null;
    return { endpoint: `${u.protocol}//${u.host}/api/${projectId}/store/`, publicKey: u.username };
  } catch {
    return null;
  }
}

export function sentryConfigured(): boolean {
  return Boolean(process.env.SENTRY_DSN?.trim() && parseDsn(process.env.SENTRY_DSN.trim()));
}

export function captureException(err: unknown, context: Record<string, unknown> = {}): void {
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) return;
  const parsed = parseDsn(dsn);
  if (!parsed) return;

  const error = err instanceof Error ? err : new Error(String(err));
  const event = {
    event_id: crypto.randomUUID().replace(/-/g, ''),
    timestamp: new Date().toISOString(),
    platform: 'node',
    level: 'error',
    logger: 'fitflow',
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'development',
    exception: { values: [{ type: error.name, value: error.message, stacktrace: undefined }] },
    extra: context,
    tags: { app: 'fitflow' },
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    void fetch(parsed.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${parsed.publicKey}, sentry_client=fitflow/1`,
      },
      body: JSON.stringify(event),
      signal: controller.signal,
    })
      .catch(() => undefined)
      .finally(() => clearTimeout(timer));
  } catch {
    /* never throw from error reporting */
  }
}
