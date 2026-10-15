import { NextResponse } from 'next/server';
import { versionInfo } from '@/lib/version';

export const dynamic = 'force-dynamic';

/**
 * GET /api/version — { commit, builtAt } of the running build (lib/version.ts). Exempt from auth: no data behind it.
 *
 * The two values are read as LITERAL `process.env.X` expressions on purpose: next.config.ts stamps BUILT_AT through
 * its `env` map, which Next inlines at build time only where the exact expression `process.env.BUILT_AT` appears.
 * Passing `process.env` as an object and reading the key dynamically returned null on the first live build
 * (2026-10-15, commit 246b516).
 */
export async function GET() {
  const info = versionInfo({ VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA, BUILT_AT: process.env.BUILT_AT });
  return NextResponse.json(info, { headers: { 'Cache-Control': 'no-store' } });
}
