// Ephemeral Postgres for DB-backed tests, via testcontainers. Applies the web
// schema (pgcrypto + every drizzle/migrations/*.sql in lex order — the single
// source of truth) exactly as production does. Skipped gracefully when Docker is
// unavailable (mirrors conftest.py::pg_pool).

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { sql } from "drizzle-orm";

import { type Db, closeDb, getDb, initDb } from "../src/db";
import { closeSecretsDb, initSecretsDb } from "../src/secretsDb";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "web", "drizzle", "migrations");

function schemaSql(): string {
  const parts = ['CREATE EXTENSION IF NOT EXISTS "pgcrypto";'];
  for (const name of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    parts.push(readFileSync(join(migrationsDir, name), "utf8"));
  }
  return parts.join("\n");
}

export interface PgHandle {
  db: Db;
  stop: () => Promise<void>;
}

// Start a container, apply the schema, wire the global Db (initDb) so route
// handlers' getDb() hits it. Throws if Docker can't be reached — callers skip.
export async function startPg(): Promise<PgHandle> {
  const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
  const container = await new PostgreSqlContainer("postgres:16").start();
  const dsn = container.getConnectionUri();
  await closeDb();
  await closeSecretsDb();
  const db = await initDb(dsn);
  // drizzle-orm splits on `;`-less statements oddly; run the whole file raw.
  await db.execute(sql.raw(schemaSql()));
  // The secrets store (ADR-098) is a separate instance in prod; in tests it shares
  // the container — initSecretsDb creates the question_secrets table here.
  await initSecretsDb(dsn);
  return {
    db,
    stop: async () => {
      await closeSecretsDb();
      await closeDb();
      await container.stop();
    },
  };
}

// Remove all rows between tests (one container per file; truncate for isolation).
export async function truncateAll(db: Db): Promise<void> {
  await db.execute(
    sql.raw(
      "TRUNCATE envelopes, aggregates, revocations, registrations, asker_admins, " +
        "self_nullifier_invalidations, self_chain_cursors, question_secrets, " +
        "referral_codes, referrals, reputation, board_members, questions, askers " +
        "RESTART IDENTITY CASCADE",
    ),
  );
}

export { getDb };
