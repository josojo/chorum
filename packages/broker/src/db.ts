// Postgres (postgres-js) client + Drizzle instance lifecycle.
//
// A single module-level client/db is created on app startup and torn down on
// shutdown. Tests can also call initDb(dsn) directly. Mirrors the Python
// db/client.py asyncpg pool lifecycle.

import postgres, { type Sql } from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "./schema";
import { getSettings } from "./config";

export type Db = PostgresJsDatabase<typeof schema>;

let _sql: Sql | null = null;
let _db: Db | null = null;

export async function initDb(dsn?: string): Promise<Db> {
  if (_db !== null) return _db;
  const settings = getSettings();
  _sql = postgres(dsn ?? settings.databaseUrl, {
    max: settings.dbPoolMaxSize,
    // postgres-js opens connections lazily; the pool floor is implicit.
  });
  _db = drizzle(_sql, { schema });
  return _db;
}

export function getDb(): Db {
  if (_db === null) {
    throw new Error("DB not initialized; call initDb() first");
  }
  return _db;
}

export async function closeDb(): Promise<void> {
  if (_sql !== null) {
    await _sql.end({ timeout: 5 });
    _sql = null;
    _db = null;
  }
}
