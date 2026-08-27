import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'lib/**/*.test.ts'],
    environment: 'node',
    // Tests NEVER touch a real database: in-memory PGlite, DATABASE_URL blanked.
    env: { PGLITE_DATA_DIR: 'memory', DATABASE_URL: '' },
    testTimeout: 30_000,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
});
