# hearme-broker

The dispatcher + envelope verifier for Hearme v0. Specified by
[ARCHITECTURE.md §5](../../ARCHITECTURE.md). One Python service, one
binary, two responsibilities:

1. Dispatch open questions to polling agents (`GET /v1/questions/open`).
2. Verify and persist envelopes returned by agents (`POST /v1/envelopes`).

Plus `GET /healthz`.

The broker is the **only** writer to `envelopes`, `aggregates`, and
`revocations`. The frontend cannot write them; agents cannot bypass it.

## Run

```bash
cd packages/broker
pip install -e ".[dev]"      # or: uv pip install -e ".[dev]"

# DB DSN must point at the shared Postgres using the hearme_broker role.
export HEARME_BROKER_DATABASE_URL="postgres://hearme_broker:hearme_broker_dev@localhost:5432/hearme"

uvicorn hearme_broker.main:app --reload --port 8001
```

Start Postgres first with `scripts/dev-up.sh` from the repo root.

### Settings

All settings are read from environment variables prefixed `HEARME_BROKER_`:

| Variable                                 | Default                                                                | Meaning                                              |
|------------------------------------------|------------------------------------------------------------------------|------------------------------------------------------|
| `HEARME_BROKER_DATABASE_URL`             | `postgres://hearme_broker:hearme_broker_dev@localhost:5432/hearme`     | asyncpg DSN, must use the `hearme_broker` role.      |
| `HEARME_BROKER_DB_POOL_MIN_SIZE`         | `1`                                                                    | asyncpg pool min size.                               |
| `HEARME_BROKER_DB_POOL_MAX_SIZE`         | `10`                                                                   | asyncpg pool max size.                               |
| `HEARME_BROKER_EXPOSE_REJECTION_REASONS` | `True`                                                                 | v0: include specific reason codes; turn off in prod. |
| `HEARME_BROKER_ZKPASSPORT_BRIDGE_URL`    | `http://localhost:8787`                                                | zkpassport-bridge `/verify` base URL (broker-controlled). |
| `HEARME_BROKER_ZKPASSPORT_VERIFY_TIMEOUT_SECONDS` | `30.0`                                                        | Timeout for the bridge verify call.                 |

## Verification pipeline

Per envelope, in order (ARCHITECTURE.md §5):

1. Parse with Pydantic (`extra="forbid"`). Schema-invalid bodies return 422.
2. Verify the zkPassport proof in `zkpassport_proof` — a **real Noir/UltraHonk
   proof** re-verified via the zkpassport-bridge (`verify/zkpassport.py` →
   `verify/bridge_client.py`) — plus its bindings: `agent_key` (bound in-circuit
   via `custom_data`), scope, nullifier ↔ `unique_identifier`, and predicates.
3. Check `token.expires_at > now()`.
4. Check `token.delegation_hash` not present in `revocations`.
5. Recompute `delegation_hash = SHA-256(canonical_json(delegation_token))`.
6. Verify `agent_signature` over `SHA-256(question_id || answer || nonce || delegation_hash)`
   using `token.agent_key`.
7. Check `question_id` exists, `status='open'`, `closes_at > now()`, and the
   envelope's `nonce` equals the row's `nonce`.
8. Check the token's signed demographic predicates are eligible for the
   question scope (`worldwide`, matching `continent`/legacy `region`, or
   matching `country`).
9. INSERT envelope. The composite primary key
   `(question_id, unique_identifier)` is the DB-level Sybil gate; duplicates
   bounce here.
10. Increment the `aggregates` row for that `question_id` (count +
   `by_predicate` JSON), inside the same transaction as the INSERT.

A failure at any step rejects the envelope. Detailed reasons are returned to
the agent in v0 for debugging; **production should set
`HEARME_BROKER_EXPOSE_REJECTION_REASONS=False`** so the broker is not an
oracle for which bit of an envelope went wrong.

## Wire formats

Exactly mirror `packages/proto/{delegation,envelope,question}.json`:

- `GET /v1/questions/open` returns `created_at` with each question. Agents use
  the max returned `created_at` as their next `since` cursor, which avoids
  coupling polling correctness to the agent host's local clock.
- `POST /v1/envelopes` accepts a body with exactly five top-level fields:
  `{question_id, answer, nonce, delegation_token, agent_signature}`. Any
  extra field is rejected (boundary-leakage assertion, ARCHITECTURE.md §12).
- `DelegationToken` has the nine fields listed in §8.5.

The agent signs `SHA-256(question_id || answer || nonce || delegation_hash)`
where the four parts are joined with a literal ASCII `|` separator. That
separator choice is pinned in
`src/hearme_broker/verify/envelope.py::envelope_signing_input` and the
forthcoming `hearme-skill` package must mirror it byte-for-byte.

## Database role grants required

The broker connects as `hearme_broker`, which `db/init/02-roles.sql`
defines with:

```sql
GRANT SELECT, INSERT, UPDATE  ON envelopes   TO hearme_broker;
GRANT SELECT, INSERT, UPDATE  ON aggregates  TO hearme_broker;
GRANT SELECT, INSERT          ON revocations TO hearme_broker;
GRANT SELECT, UPDATE          ON questions   TO hearme_broker;  -- read; UPDATE for future nonce rotation
GRANT SELECT                  ON askers      TO hearme_broker;
```

The broker **cannot** INSERT or DELETE `questions` or `askers`. If you
need to seed test data, do so as `hearme_admin`.

## `questions.nonce` column

Required by `GET /v1/questions/open` — the per-question random value the
agent binds into `agent_signature`. **Already present** in the canonical
schema at `packages/web/drizzle/0000_init.sql`:

```sql
nonce TEXT NOT NULL DEFAULT encode(gen_random_bytes(16), 'base64'),
```

The broker reads this column but does not create or rotate it in v0. No
migration shipped by this package. If web ever drops the column, the
broker will return 500 on `/v1/questions/open` and reject envelopes with
`nonce_mismatch`.

## Tests

```bash
cd packages/broker
pip install -e ".[dev]"

# Pure / in-process suites — no Docker required.
pytest tests/test_canonical_json.py tests/test_verify_delegation.py tests/test_verify_envelope.py tests/test_eligibility.py tests/test_aggregate_recompute.py::test_compute_by_predicate_hand_computation tests/test_aggregate_recompute.py::test_compute_by_predicate_empty tests/test_aggregate_recompute.py::test_compute_by_predicate_handles_missing_field

# Full suite — requires Docker for testcontainers-managed Postgres.
pytest
```

The Postgres-dependent tests (`test_uniqueness.py`,
`test_aggregate_recompute.py::test_increment_aggregate_against_real_pg`) spin up an
ephemeral Postgres 16 via [`testcontainers`](https://testcontainers-python.readthedocs.io/)
and apply the canonical schema from `packages/web/drizzle/0000_init.sql`.
If Docker isn't available they skip cleanly.

## Not yet real (v0 stubs)

Search for `# STUB:` in code to find these. Mirrors ARCHITECTURE.md §11.

- **zkPassport circuit verification — now real.** `verify/zkpassport.py`
  re-verifies the real Noir/UltraHonk proof via the zkpassport-bridge
  (`HEARME_BROKER_ZKPASSPORT_BRIDGE_URL`). Point it at a bridge the broker
  controls. Mock-passport proofs verify only when the bridge runs `devMode=1`.
- **Honeypot signal handling.** The broker accepts honeypot envelopes
  like any other; no per-user scoring is emitted. v0.2 adds this.
- **Revocation publishing.** The `revocations` table is read on every
  envelope, but the broker does not yet expose `POST /v1/revocations`.
  Phone-side revocation flow lands in v0.2.
- **Production rejection-reason concealment.** v0 returns specific
  rejection reasons. Production should set
  `HEARME_BROKER_EXPOSE_REJECTION_REASONS=False`.

## Layout

```
packages/broker/
├── pyproject.toml
├── README.md
├── src/hearme_broker/
│   ├── __init__.py
│   ├── main.py                   # FastAPI app factory
│   ├── config.py                 # env-driven settings
│   ├── aggregates.py             # pure aggregate helpers
│   ├── eligibility.py            # signed-predicate scope eligibility
│   ├── routes/
│   │   ├── questions.py          # GET /v1/questions/open
│   │   └── envelopes.py          # POST /v1/envelopes
│   ├── verify/
│   │   ├── canonical.py          # deterministic JSON + SHA-256
│   │   ├── delegation.py         # expiry + zkPassport verification
│   │   ├── zkpassport.py         # bindings + real SNARK check (via bridge)
│   │   ├── bridge_client.py      # HTTP client for the zkpassport-bridge
│   │   └── envelope.py           # agent signature + linkage
│   ├── models/
│   │   └── schemas.py            # Pydantic models, extra="forbid"
│   └── db/
│       ├── client.py             # asyncpg pool lifecycle
│       └── queries.py            # parameterized queries only
└── tests/
    ├── conftest.py
    ├── test_canonical_json.py
    ├── test_verify_delegation.py
    ├── test_verify_envelope.py
    ├── test_uniqueness.py            # real Postgres via testcontainers
    └── test_aggregate_recompute.py   # pure + real-Postgres
```
