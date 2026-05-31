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
| `HEARME_BROKER_SELF_BRIDGE_URL`          | `http://localhost:8787`                                                | self-bridge `/verify` base URL (broker-controlled); used only at registration. |
| `HEARME_BROKER_SELF_VERIFY_TIMEOUT_SECONDS` | `30.0`                                                              | Timeout for the bridge verify call.                 |
| `HEARME_BROKER_REQUIRE_REGISTRY_CONFIRMATION` | `True`                                                            | Require the bridge's on-chain Celo registry/root check at registration. |
| `HEARME_BROKER_SIGNING_KEY`              | dev key                                                                | base64 32-byte Ed25519 seed signing the DelegationToken. **Override in prod.** |
| `HEARME_BROKER_SELF_REVOCATION_LISTENER_ENABLED` | `False`                                                       | Poll Self on-chain invalidation/update events and revoke matching Hearme identities/votes. |
| `HEARME_BROKER_SELF_REVOCATION_RPC_URL`  | —                                                                      | JSON-RPC endpoint for the chain carrying Self invalidation events. |
| `HEARME_BROKER_SELF_REVOCATION_CONTRACT_ADDRESS` | —                                                              | Self contract address emitting invalidation/update events. |
| `HEARME_BROKER_SELF_REVOCATION_EVENT_TOPIC` | —                                                                   | Keccak event signature topic for the Self invalidation/update event. |
| `HEARME_BROKER_SELF_REVOCATION_NULLIFIER_TOPIC_INDEX` | `1`                                                        | Topic index containing the invalidated nullifier; set `-1` if it is in event data. |
| `HEARME_BROKER_SELF_REVOCATION_NULLIFIER_DATA_WORD_INDEX` | `-1`                                                   | ABI data word containing the invalidated nullifier when it is not indexed. |
| `HEARME_BROKER_SELF_REVOCATION_FROM_BLOCK` | `0`                                                                 | Initial block when no cursor exists. |
| `HEARME_BROKER_SELF_REVOCATION_CONFIRMATIONS` | `12`                                                            | Blocks to lag behind head before processing logs. |

## Registration pipeline (`POST /v1/register`)

The only path that touches a Self proof — verify-once (ARCHITECTURE.md §5/§8):

1. Parse the `EnrollmentBundle` (`self_proofs[]`, `agent_key`).
2. For each proof: real SNARK verify via the self-bridge (`verify/self_identity.py`
   → `verify/bridge_client.py`), require the on-chain `registryConfirmed`, enforce
   bindings (`agent_key` ↔ `userDefinedData`, one shared nullifier).
3. Derive authoritative `region`/`age_band` (`verify/predicates.py`).
4. Atomically bind `nullifier → agent_key` in `registrations` (a different
   agent_key for a live nullifier ⇒ `identity_already_bound`).
5. Mint + return the broker-signed `DelegationToken` (`verify/credential.py`).

## Verification pipeline (`POST /v1/envelopes`)

Per envelope, in order — **no bridge call, no Self proof** at answer time:

1. Parse with Pydantic (`extra="forbid"`). Schema-invalid bodies return 422.
2. Verify the broker's own signature on the `delegation_token` + `expires_at > now()`
   (`verify/delegation.py` → `verify/credential.py`).
3. Check `delegation_hash` not in `revocations`; the `registrations` row exists,
   binds the same `agent_key`, and `revoked_at IS NULL`.
4. Recompute `delegation_hash = SHA-256(canonical_json(delegation_token))`.
5. Verify `agent_signature` over `SHA-256(question_id || answer || nonce || delegation_hash)`
   using `token.agent_key`.
6. Check `question_id` exists, `status='open'`, `closes_at > now()`, `nonce` matches.
7. Check the predicates are eligible for the question scope (`worldwide`,
   matching `continent`/`region`, or `country`).
8. INSERT envelope. The composite primary key `(question_id, unique_identifier)`
   is the DB-level Sybil gate; duplicates bounce here.
9. Increment the `aggregates` row, inside the same transaction as the INSERT.

A failure at any step rejects the envelope. Detailed reasons are returned to
the agent in v0 for debugging; **production should set
`HEARME_BROKER_EXPOSE_REJECTION_REASONS=False`** so the broker is not an
oracle for which bit of an envelope went wrong.

## Self on-chain invalidations

Because Self proofs are verified once at registration, the broker runs an
optional background listener for Self on-chain invalidation/update events. When a
configured event emits an old nullifier, the broker:

1. records the invalidation in `self_nullifier_invalidations`;
2. sets `registrations.revoked_at` for the matching `unique_identifier`;
3. deletes accepted envelopes from that nullifier;
4. recomputes each affected aggregate in the same transaction.

This means a Self-side identity recovery/update stops both future votes and
already-counted votes for the old Hearme nullifier. The listener is ABI-driven by
env vars because the concrete Self event name/topic must be supplied by the
deployment. Until those vars are set, it remains disabled.

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

The broker connects as `hearme_broker`, which `db/init/02-roles.sh`
defines with:

```sql
GRANT SELECT, INSERT, UPDATE  ON envelopes     TO hearme_broker;
GRANT SELECT, INSERT, UPDATE  ON aggregates    TO hearme_broker;
GRANT SELECT, INSERT          ON revocations   TO hearme_broker;
GRANT SELECT, INSERT, UPDATE  ON registrations TO hearme_broker;
GRANT SELECT, INSERT, UPDATE  ON self_nullifier_invalidations TO hearme_broker;
GRANT SELECT, INSERT, UPDATE  ON self_chain_cursors           TO hearme_broker;
GRANT SELECT, UPDATE          ON questions     TO hearme_broker;  -- read; UPDATE for future nonce rotation
GRANT SELECT                  ON askers        TO hearme_broker;
```

The broker **cannot** INSERT or DELETE `questions` or `askers`. If you
need to seed test data, do so as `hearme_admin`.

## `questions.nonce` column

Required by `GET /v1/questions/open` — the per-question random value the
agent binds into `agent_signature`. **Already present** in the canonical
schema at `packages/web/drizzle/schema.sql`:

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
and apply the canonical schema from `packages/web/drizzle/schema.sql`.
If Docker isn't available they skip cleanly.

## Not yet real (v0 stubs)

Search for `# STUB:` in code to find these. Mirrors ARCHITECTURE.md §11.

- **Self proof verification — real, verify-once.** `verify/self_identity.py`
  verifies the Self proofs at `POST /v1/register` via the self-bridge
  (`HEARME_BROKER_SELF_BRIDGE_URL`) and the broker issues a signed
  `DelegationToken`; envelopes carry only that. Point the bridge at one the
  broker controls. Mock-passport proofs verify only with `SELF_MOCK_PASSPORT=1`.
- **On-chain registry check.** Enabled via `HEARME_BROKER_REQUIRE_REGISTRY_CONFIRMATION`
  + the bridge's `SELF_CELO_RPC_URL`/`SELF_REGISTRY_ADDRESS`. The exact registry
  contract is the documented impl open item (SELF_MIGRATION.md).
- **Self invalidation event wiring.** The broker listener exists, but production
  must supply the concrete Self contract address, event topic, and nullifier
  position via `HEARME_BROKER_SELF_REVOCATION_*`.
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
│   │   ├── register.py          # POST /v1/register (verify-once)
│   │   └── envelopes.py          # POST /v1/envelopes
│   ├── verify/
│   │   ├── canonical.py          # deterministic JSON + SHA-256
│   │   ├── self_identity.py      # registration: real SNARK check (via bridge) + bindings
│   │   ├── predicates.py         # country→region, thresholds→age_band
│   │   ├── credential.py         # issue + verify the broker-signed DelegationToken
│   │   ├── delegation.py         # per-envelope: broker sig + expiry
│   │   ├── bridge_client.py      # HTTP client for the self-bridge
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
