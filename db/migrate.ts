/**
 * Apply ./migrations to whichever database is configured (see db/index.ts).
 * Run with `npm run db:migrate`. Safe to re-run: drizzle tracks applied
 * migrations in the `__drizzle_migrations` table.
 */
import path from 'path';
import * as schema from './schema';

const migrationsFolder = path.join(__dirname, '..', 'migrations');

export async function runMigrations(): Promise<void> {
  if (
    !process.env.VITEST &&
    !process.env.PGLITE_DATA_DIR &&
    process.env.DATABASE_URL === undefined &&
    typeof process.loadEnvFile === 'function'
  ) {
    try {
      process.loadEnvFile(path.join(process.cwd(), '.env.local'));
    } catch {
      /* embedded PGlite */
    }
  }
  const url = process.env.DATABASE_URL?.trim();

  if (url) {
    const postgres = (await import('postgres')).default;
    const { drizzle } = await import('drizzle-orm/postgres-js');
    const { migrate } = await import('drizzle-orm/postgres-js/migrator');
    const client = postgres(url, { prepare: false, max: 1 });
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder });
    await client.end();
    return;
  }

  const { db } = await import('./index');
  const { migrate } = await import('drizzle-orm/pglite/migrator');
  await migrate(db as unknown as import('drizzle-orm/pglite').PgliteDatabase, {
    migrationsFolder,
  });
}

if (require.main === module) {
  runMigrations()
    .then(() => {
      console.log('✓ Migrations applied');
      process.exit(0);
    })
    .catch((err) => {
      console.error('✗ Migration failed:', err);
      process.exit(1);
    });
}
