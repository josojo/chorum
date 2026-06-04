// Connection to the per-question linkage-secret store (ADR-098, ARCHITECTURE_V0.md
// §1.4). The secrets live in a broker-OWNED database (`hearme_secrets`), separate
// from the shared `hearme` DB that holds envelopes / registrations / questions —
// because the broker has only USAGE (not CREATE) on the shared schema, and
// because the web/classifier roles must have no path to linkage material. In
// production this database is co-located on the SAME RDS instance as the main DB;
// at-rest protection comes from WRAPPING each secret under the master key
// (questionSecret.ts), so a dump of that instance yields only ciphertext, and the
// real "unlink at close" guarantee comes from destroying the wrapped secret.
//
// The store carries ONLY per-question key material; a destroyed secret is MEANT
// to be unrecoverable (its question's answers become unlinkable even to the
// broker). In dev/CI this DSN points at the same Postgres container.

import postgres, { type Sql } from "postgres";

import { getSettings } from "./config";

let _sql: Sql | null = null;

// Create + schema-init the secrets pool. Idempotent: a second call returns the
// existing pool. Tests call initSecretsDb(dsn) directly against their container.
export async function initSecretsDb(dsn?: string): Promise<Sql> {
  if (_sql !== null) return _sql;
  const settings = getSettings();
  _sql = postgres(dsn ?? settings.secretsDatabaseUrl, { max: settings.dbPoolMaxSize });
  await ensureSecretsSchema(_sql);
  return _sql;
}

export function getSecretsDb(): Sql {
  if (_sql === null) {
    throw new Error("secrets DB not initialized; call initSecretsDb() first");
  }
  return _sql;
}

export async function closeSecretsDb(): Promise<void> {
  if (_sql !== null) {
    await _sql.end({ timeout: 5 });
    _sql = null;
  }
}

// The broker owns this schema (the table lives in the broker-owned `hearme_secrets`
// database, not in the web Drizzle migrations — web must never see linkage
// material, and keeping it out of the shared schema avoids the verify-db.sh
// boundary + drizzle drift checks). `secret` holds the WRAPPED s_q (AES-256-GCM
// blob, questionSecret.ts), NULLed at close + grace by the reaper; `closes_at` is
// copied from the question at lazy-create so the reaper is a pure single-query
// sweep that never has to reach back into the main DB.
async function ensureSecretsSchema(db: Sql): Promise<void> {
  await db`
    CREATE TABLE IF NOT EXISTS question_secrets (
      question_id  UUID PRIMARY KEY,
      secret       BYTEA,                            -- wrapped s_q (iv|tag|ct); NULL once destroyed
      closes_at    TIMESTAMPTZ NOT NULL,             -- copied from questions.closes_at at create
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      destroyed_at TIMESTAMPTZ                        -- NULL until close + grace
    )
  `;
  // The reaper scans live rows by close time; index just those.
  await db`
    CREATE INDEX IF NOT EXISTS question_secrets_live_closes_at
      ON question_secrets (closes_at) WHERE secret IS NOT NULL
  `;
}
