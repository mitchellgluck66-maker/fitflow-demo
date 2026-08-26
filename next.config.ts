import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Native/WASM database drivers must not be bundled by webpack/turbopack.
  serverExternalPackages: ['@electric-sql/pglite', 'postgres'],
};

export default nextConfig;
