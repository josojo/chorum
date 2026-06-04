// Connection to the per-question linkage-secret store (ADR-098, ARCHITECTURE_V0.md
// §1.4). This is a SEPARATE Postgres instance from the shared DB that holds
// envelopes / registrations / questions — deliberately so. RDS automated backups
// are instance-wide, so durable backups of the envelopes data and a SHORT
// deletion horizon for the secrets cannot coexist in one instance; splitting the
// instances decouples them. The secrets instance:
//   - is broker-only (no web/classifier/analytics role or network path to it);
//   - is backup-retention-minimal (0–1 day) — its retention IS the unlink horizon;
//   - holds ONLY per-question key material, nothing whose loss hurts durability
//     (a destroyed secret is MEANT to be unrecoverable).
//
// In dev/CI this DSN defaults to the same Postgres as the main DB (one container,
// one extra table) — the instance separation is a production deployment concern.
// startupChecks.ts refuses to boot in production if the two DSNs share a host.

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

// The broker owns this schema (the table lives in the secrets instance, not in
// the web Drizzle migrations — web must never see linkage material). `secret` is
// 32 random bytes, NULLed at close + grace by the reaper (questionSecret.ts);
// `closes_at` is copied from the question at lazy-create so the reaper is a pure
// single-instance query that never has to reach back into the main DB.
async function ensureSecretsSchema(db: Sql): Promise<void> {
  await db`
    CREATE TABLE IF NOT EXISTS question_secrets (
      question_id  UUID PRIMARY KEY,
      secret       BYTEA,                            -- 32 random bytes; NULL once destroyed
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
