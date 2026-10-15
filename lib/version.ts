/**
 * Which build is serving — so a deploy can be confirmed from outside (2026-10-15):
 *
 *   GET /api/version → { "commit": "2454fa2…", "builtAt": "2026-10-15T13:20:11.000Z" }
 *
 * `commit` is Vercel's VERCEL_GIT_COMMIT_SHA (null outside Vercel); `builtAt` is stamped by next.config.ts at build
 * time (null when the build did not set it; the route must read the literal `process.env.BUILT_AT` — see
 * app/api/version/route.ts). Both are nullable on purpose: a missing value says "not a Vercel build",
 * never a made-up SHA. No business data, no secret — the route is exempt from the session gate (lib/auth/policy.ts).
 */
export interface VersionInfo {
  commit: string | null;
  builtAt: string | null;
}

export function versionInfo(env: Record<string, string | undefined> = process.env): VersionInfo {
  const commit = env.VERCEL_GIT_COMMIT_SHA?.trim() || null;
  const builtAt = env.BUILT_AT?.trim() || null;
  return { commit, builtAt };
}
