import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'lib/**/*.test.ts'],
    environment: 'node',
    // Tests NEVER touch a real database: in-memory PGlite, DATABASE_URL blanked.
    env: { PGLITE_DATA_DIR: 'memory', DATABASE_URL: '' },
    testTimeout: 30_000,
    // Each DB-backed file boots its own PGlite (WASM) and runs every migration
    // in beforeAll/beforeEach; with ~40 files in parallel that can exceed the
    // 10 s default hook budget on a busy machine. Hooks get the same 30 s as tests.
    hookTimeout: 30_000,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
});
