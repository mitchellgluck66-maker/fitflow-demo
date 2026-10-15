import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Native/WASM database drivers must not be bundled by webpack/turbopack.
  serverExternalPackages: ['@electric-sql/pglite', 'postgres'],
  // Stamped once per build and inlined: GET /api/version reports it beside VERCEL_GIT_COMMIT_SHA (lib/version.ts).
  env: { BUILT_AT: new Date().toISOString() },
};

export default nextConfig;
