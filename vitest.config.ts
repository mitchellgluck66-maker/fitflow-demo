import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'lib/**/*.test.ts'],
    environment: 'node',
    env: { PGLITE_DATA_DIR: 'memory' },
    testTimeout: 30_000,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
});
