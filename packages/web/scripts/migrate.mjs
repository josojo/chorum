#!/usr/bin/env node
// Tiny idempotent SQL migrator.
//
// What it does:
//   1. Connects to MIGRATOR_DATABASE_URL (admin-rights DSN — needs ALTER).
//   2. Creates `_schema_migrations(version TEXT PRIMARY KEY, applied_at …)`
//      if missing.
//   3. Baseline guard: if the table is empty AND `questions` already exists
//      (i.e. the volume was bootstrapped by docker-entrypoint-initdb's
//      canonical schema.sql before this migrator ever ran), record `0000_init`
//      as already-applied — otherwise the migrator would try to re-run the
//      baseline and explode on duplicate tables.
//   4. Reads every *.sql file under drizzle/migrations/ in lex order; for
//      each version not yet in `_schema_migrations`, runs the file inside a
//      single transaction and inserts the version row in the same tx.
//
// Re-running it on a fully-migrated DB is a no-op. Designed to run as a
// one-shot service that `web` depends on (see docker-compose.yml).

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Hand-written *.sql deltas applied on top of the canonical schema.sql baseline,
// in lex order. Overridable so tests can point the migrator at a fixture set.
const MIGRATIONS_DIR =
  process.env.HEARME_MIGRATIONS_DIR ??
  join(__dirname, "..", "drizzle", "migrations");
const BASELINE_VERSION = "0000_init";
// Sentinel: every DB schema we'd want to baseline has this table.
const BASELINE_TABLE = "questions";

const dsn = process.env.MIGRATOR_DATABASE_URL;
if (!dsn) {
  console.error("MIGRATOR_DATABASE_URL is required");
  process.exit(2);
}

const sql = postgres(dsn, { max: 1, onnotice: () => {} });

function listMigrations() {
  let entries;
  try {
    entries = readdirSync(MIGRATIONS_DIR, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter((d) => d.isFile() && d.name.endsWith(".sql"))
    .map((d) => ({
      version: d.name.replace(/\.sql$/, ""),
      path: join(MIGRATIONS_DIR, d.name),
    }))
    .sort((a, b) => (a.version < b.version ? -1 : 1));
}

async function ensureMigrationsTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS _schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
}

async function baselineIfNeeded() {
  const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM _schema_migrations`;
  if (count > 0) return;
  // to_regclass returns NULL when the relation is absent.
  const [{ exists }] = await sql`
    SELECT to_regclass('public.' || ${BASELINE_TABLE}) IS NOT NULL AS exists
  `;
  if (!exists) {
    // Fresh volume on a host that ISN'T using docker-entrypoint-initdb to
    // bootstrap the schema. Today that's only the test harness, which
    // applies its baseline itself before invoking us — so this branch
    // exists for future flexibility, not as a supported prod path.
    return;
  }
  console.log(`[migrate] baselining ${BASELINE_VERSION} (tables already present)`);
  await sql`INSERT INTO _schema_migrations(version) VALUES (${BASELINE_VERSION})`;
}

async function appliedVersions() {
  const rows = await sql`SELECT version FROM _schema_migrations`;
  return new Set(rows.map((r) => r.version));
}

async function applyMigration(version, path) {
  const body = readFileSync(path, "utf8");
  console.log(`[migrate] applying ${version}`);
  await sql.begin(async (tx) => {
    await tx.unsafe(body);
    await tx`INSERT INTO _schema_migrations(version) VALUES (${version})`;
  });
}

async function main() {
  await ensureMigrationsTable();
  await baselineIfNeeded();
  const applied = await appliedVersions();
  const migrations = listMigrations();
  let n = 0;
  for (const { version, path } of migrations) {
    if (applied.has(version)) continue;
    await applyMigration(version, path);
    n++;
  }
  console.log(`[migrate] done (${n} applied, ${applied.size + n} total)`);
}

main()
  .catch((err) => {
    console.error("[migrate] FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => sql.end({ timeout: 5 }));
