import type { Config } from 'drizzle-kit';

export default {
  schema: './db/schema.ts',
  out: './migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.DATABASE_URL || './db/fitflow.db',
  },
} satisfies Config;
