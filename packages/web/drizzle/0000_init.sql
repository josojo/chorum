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
  -- Ordered list of poll options the agents pick from. The classifier matches
  -- the leading word of the answer (case-insensitive) against these labels;
  -- yes/no is the 2-option default and still uses the multilingual yes/no
  -- synonym table (see packages/broker/.../aggregates.py).
  options     JSONB NOT NULL DEFAULT '["yes","no"]'::jsonb,
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
  ),
  CONSTRAINT questions_options_chk CHECK (
    jsonb_typeof(options) = 'array'
    AND jsonb_array_length(options) BETWEEN 2 AND 8
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
  -- Per-option tally per bucket. Each tally is a map from the question's
  -- option labels to counts; yes/no is the 2-option case, e.g.
  --   {"region:EU": {"yes": 30, "no": 12}, ...}
  -- For an N-option poll the same shape carries arbitrary labels, e.g.
  --   {"region:EU": {"pizza": 22, "pasta": 14, "sushi": 9}, ...}
  by_predicate   JSONB NOT NULL DEFAULT '{}',
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE revocations (
  delegation_hash TEXT PRIMARY KEY,
  revoked_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Self nullifier registry. Written ONCE per verified human at POST /v1/register
-- (verify-once-at-registration). Keyed by the scope-bound Self nullifier
-- (== DelegationToken.unique_identifier). ``agent_key`` is the base64 Ed25519
-- public key bound to this nullifier; re-registration is accepted if the
-- agent_key matches (refresh), and an attempt to bind a *different* agent_key
-- to a known, non-revoked nullifier is rejected as ``identity_already_bound``
-- (the atomic Sybil bind). This table also backs the broker-issued
-- DelegationToken: the per-envelope path checks agent_key matches and
-- revoked_at IS NULL here. See ARCHITECTURE.md §3, §5, §8 + verify/self_identity.py.
CREATE TABLE registrations (
  unique_identifier    TEXT PRIMARY KEY,
  agent_key            TEXT NOT NULL,
  disclosed_predicates JSONB NOT NULL,
  issued_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at           TIMESTAMPTZ NOT NULL,
  revoked_at           TIMESTAMPTZ
);

-- Broker-side record of Self on-chain invalidation events that revoked a
-- previously accepted nullifier. The broker treats these as authoritative:
-- future envelopes from that nullifier reject, and already accepted envelopes
-- are removed from aggregates when the invalidation is applied.
CREATE TABLE self_nullifier_invalidations (
  unique_identifier TEXT PRIMARY KEY,
  source            TEXT NOT NULL,
  chain_id          TEXT,
  block_number      BIGINT NOT NULL,
  log_index         INTEGER NOT NULL,
  tx_hash           TEXT NOT NULL,
  observed_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cursor for the broker's Self on-chain invalidation listener.
CREATE TABLE self_chain_cursors (
  name        TEXT PRIMARY KEY,
  last_block  BIGINT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX envelopes_question_id_idx ON envelopes(question_id);
CREATE INDEX envelopes_submitted_at_idx ON envelopes(submitted_at);
CREATE INDEX registrations_agent_key_idx ON registrations(agent_key);
