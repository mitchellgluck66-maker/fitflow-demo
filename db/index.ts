import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import path from 'path';

// Create or connect to local SQLite database
// Use absolute path to ensure it works from any working directory
const dbPath = process.env.DATABASE_URL || path.join(process.cwd(), 'db', 'fitflow.db');
const sqlite = new Database(dbPath);

// Enable foreign keys
sqlite.pragma('foreign_keys = ON');

// Initialize Drizzle ORM
export const db = drizzle(sqlite, { schema });

export type {
  Lead,
  NewLead,
  LeadEvent,
  NewLeadEvent,
  Appointment,
  NewAppointment,
  GhlSyncQueueItem,
  NewGhlSyncQueueItem,
  AppSetting,
} from './schema';
export { leads, leadEvents, appointments, ghlSyncQueue, appSettings } from './schema';
