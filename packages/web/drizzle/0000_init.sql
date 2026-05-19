-- Hearme v0 — initial schema.
-- Canonical source of truth for the shared Postgres database used by
-- hearme-web and hearme-broker. hearme-skill keeps its own local SQLite
-- ledger and does not touch this database directly.
--
-- Mirrored by packages/web/src/db/schema.ts (Drizzle).

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE askers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE questions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asker_id    UUID REFERENCES askers(id),
  text        TEXT NOT NULL,
  topic       TEXT,
  -- base64-encoded random bytes the broker echoes in GET /v1/questions/open
  -- and the agent binds into agent_signature (see ARCHITECTURE.md §8.5).
  nonce       TEXT NOT NULL DEFAULT encode(gen_random_bytes(16), 'base64'),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  closes_at   TIMESTAMPTZ NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',
  CONSTRAINT questions_status_chk CHECK (status IN ('open', 'closed'))
);

CREATE TABLE envelopes (
  question_id          UUID NOT NULL REFERENCES questions(id),
  unique_identifier    TEXT NOT NULL,
  answer               TEXT NOT NULL,
  disclosed_predicates JSONB NOT NULL,
  agent_signature      TEXT NOT NULL,
  delegation_hash      TEXT NOT NULL,
  submitted_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (question_id, unique_identifier)
);

CREATE TABLE aggregates (
  question_id    UUID PRIMARY KEY REFERENCES questions(id),
  total_answers  INTEGER NOT NULL DEFAULT 0,
  by_predicate   JSONB NOT NULL DEFAULT '{}',
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE revocations (
  delegation_hash TEXT PRIMARY KEY,
  revoked_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX envelopes_question_id_idx ON envelopes(question_id);
CREATE INDEX envelopes_submitted_at_idx ON envelopes(submitted_at);
