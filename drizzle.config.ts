import type { Config } from 'drizzle-kit';

export default {
  schema: './db/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    // Only needed for drizzle-kit push/studio; generation is offline.
    url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/fitflow',
  },
} satisfies Config;
