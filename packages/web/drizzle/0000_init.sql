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
  -- Geographic scope of the question. 'worldwide' is the broadest;
  -- 'continent' restricts to a region (continent column required);
  -- 'country' restricts to a single country (country column required,
  -- and continent is auto-set from it).
  scope       TEXT NOT NULL DEFAULT 'worldwide',
  -- ISO 3166-1 alpha-2 (e.g. 'US', 'DE', 'JP'). NULL when scope != 'country'.
  country     TEXT,
  -- Two-letter continent code: AF, AN, AS, EU, NA, OC, SA.
  -- Required when scope IN ('continent','country'); NULL for 'worldwide'.
  continent   TEXT,
  CONSTRAINT questions_status_chk CHECK (status IN ('open', 'closed')),
  CONSTRAINT questions_scope_chk  CHECK (scope IN ('worldwide','continent','country')),
  CONSTRAINT questions_continent_chk CHECK (
    continent IS NULL OR continent IN ('AF','AN','AS','EU','NA','OC','SA')
  ),
  CONSTRAINT questions_scope_geo_chk CHECK (
    (scope = 'worldwide' AND country IS NULL AND continent IS NULL)
    OR (scope = 'continent' AND country IS NULL AND continent IS NOT NULL)
    OR (scope = 'country' AND country IS NOT NULL AND continent IS NOT NULL)
  )
);

CREATE INDEX questions_scope_idx     ON questions(scope);
CREATE INDEX questions_country_idx   ON questions(country);
CREATE INDEX questions_continent_idx ON questions(continent);

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

-- ZK-passport-derived nullifier registry. One row per verified human, keyed
-- by the scope-bound passport nullifier (== DelegationToken.unique_identifier).
-- ``agent_key`` is the base64 Ed25519 public key the broker first saw bound
-- to this nullifier; refreshes are accepted if the agent_key matches, and
-- attempts to bind a *different* agent_key to a known nullifier (without
-- the previous delegation being revoked) are rejected as
-- ``identity_already_bound``. See ARCHITECTURE.md §1.4 and §8 + verify/zkpassport.py.
CREATE TABLE nullifiers (
  nullifier      TEXT PRIMARY KEY,
  agent_key      TEXT NOT NULL,
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX envelopes_question_id_idx ON envelopes(question_id);
CREATE INDEX envelopes_submitted_at_idx ON envelopes(submitted_at);
CREATE INDEX nullifiers_agent_key_idx ON nullifiers(agent_key);
