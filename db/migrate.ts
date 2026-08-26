import Database from 'better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import path from 'path';

const sqlite = new Database(process.env.DATABASE_URL || './db/fitflow.db');
const db = drizzle(sqlite);

// Run all migrations
const migrationsFolder = path.join(__dirname, '..', 'migrations');
migrate(db, { migrationsFolder });

console.log('✓ Migrations applied successfully');
sqlite.close();
