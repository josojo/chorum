# hearme-broker

The dispatcher + envelope verifier for Hearme v0. Specified by
[ARCHITECTURE_V0.md §5](../../ARCHITECTURE_V0.md). One TypeScript service
([Fastify](https://fastify.dev/) + [Drizzle](https://orm.drizzle.team/) on
[postgres-js](https://github.com/porsager/postgres) + Ed25519 via
[tweetnacl](https://github.com/dchest/tweetnacl-js)), two responsibilities:

1. Dispatch open questions to polling agents (`GET /v1/questions/open`).
2. Verify and persist envelopes returned by agents (`POST /v1/envelopes`).

Plus `POST /v1/register`, `POST /v1/envelopes/revoke`, `GET /v1/stats`, and
`GET /healthz`.

The broker is the **only** writer to `envelopes`, `aggregates`, and
`revocations`. The frontend cannot write them; agents cannot bypass it.

It reuses the Drizzle schema from `packages/web/src/db/schema.ts` (the single
source of truth for the shared Postgres schema) via `src/schema.ts`, so the DB
shape is defined exactly once across the monorepo.

## Run

```bash
cd packages/broker
npm ci

# DB DSN must point at the shared Postgres using the hearme_broker role.
export HEARME_BROKER_DATABASE_URL="postgres://hearme_broker:hearme_broker_dev@localhost:5432/hearme"

npm run dev          # tsx watch src/server.ts (listens on :8000)
# or, production-style:
npm run build && npm start
```

Start Postgres first with `scripts/dev-up.sh` from the repo root. In the docker
compose stack the broker is built from `packages/broker/Dockerfile` and listens
on `:8000`.

### Settings

All settings are read from environment variables prefixed `HEARME_BROKER_`
(see `src/config.ts`):

| Variable                                 | Default                                                                | Meaning                                              |
|------------------------------------------|------------------------------------------------------------------------|------------------------------------------------------|
| `HEARME_BROKER_DATABASE_URL`             | `postgres://hearme_broker:hearme_broker_dev@localhost:5432/hearme`     | postgres-js DSN, must use the `hearme_broker` role.  |
| `HEARME_BROKER_DB_POOL_MAX_SIZE`         | `10`                                                                   | postgres-js max pool size.                           |
| `HEARME_BROKER_EXPOSE_REJECTION_REASONS` | `true`                                                                 | v0: include specific reason codes; turn off in prod. |
| `HEARME_BROKER_SELF_BRIDGE_URL`          | `http://localhost:8787`                                                | self-bridge `/verify` base URL (broker-controlled); used only at registration. |
| `HEARME_BROKER_SELF_VERIFY_TIMEOUT_SECONDS` | `30.0`                                                              | Timeout for the bridge verify call.                 |
| `HEARME_BROKER_REQUIRE_REGISTRY_CONFIRMATION` | `true`                                                            | Require the bridge's on-chain Celo registry/root check at registration. |
| `HEARME_BROKER_SIGNING_KEY`              | dev key                                                                | base64 32-byte Ed25519 seed signing the DelegationToken. **Override in prod.** |
| `HEARME_BROKER_PRODUCTION_MODE`          | `false`                                                                | Refuse to boot if any dev default is still set (`src/startupChecks.ts`). |
| `HEARME_BROKER_DEV_INSECURE_REGISTER`    | `false`                                                                | **Testing only.** Mounts `POST /v1/dev/register` (synthetic identity, no Self proof). |
| `HEARME_BROKER_RATELIMIT_*`              | enabled; 3/h register, 30/min envelopes, 10/min revoke                 | Per-client sliding-window limits (`src/ratelimit.ts`). |
| `HEARME_BROKER_SELF_REVOCATION_LISTENER_ENABLED` | `false`                                                       | Poll Self on-chain invalidation/update events and revoke matching Hearme identities/votes. |
| `HEARME_BROKER_SELF_REVOCATION_RPC_URL`  | —                                                                      | JSON-RPC endpoint for the chain carrying Self invalidation events. |
| `HEARME_BROKER_SELF_REVOCATION_CONTRACT_ADDRESS` | —                                                              | Self contract address emitting invalidation/update events. |
| `HEARME_BROKER_SELF_REVOCATION_EVENT_TOPIC` | —                                                                   | Keccak event signature topic for the Self invalidation/update event. |
| `HEARME_BROKER_SELF_REVOCATION_NULLIFIER_TOPIC_INDEX` | `1`                                                        | Topic index containing the invalidated nullifier; set `-1` if it is in event data. |
| `HEARME_BROKER_SELF_REVOCATION_NULLIFIER_DATA_WORD_INDEX` | `-1`                                                   | ABI data word containing the invalidated nullifier when it is not indexed. |
| `HEARME_BROKER_SELF_REVOCATION_FROM_BLOCK` | `0`                                                                 | Initial block when no cursor exists. |
| `HEARME_BROKER_SELF_REVOCATION_CONFIRMATIONS` | `12`                                                            | Blocks to lag behind head before processing logs. |

## Registration pipeline (`POST /v1/register`)

The only path that touches a Self proof — verify-once (ARCHITECTURE_V0.md §5/§8):

1. Parse the `EnrollmentBundle` (`self_proofs[]`, `agent_key`) with zod (`.strict()`).
2. For each proof: real SNARK verify via the self-bridge (`verify/selfIdentity.ts`
   → `verify/bridgeClient.ts`), require the on-chain `registryConfirmed`, enforce
   bindings (`agent_key` ↔ `userDefinedData`, one shared nullifier).
3. Derive authoritative `region`/`country`/`age_band` (`verify/predicates.ts`).
4. Atomically bind `nullifier → agent_key` in `registrations` (a different
   agent_key for a live nullifier ⇒ `identity_already_bound`).
5. Mint + return the broker-signed `DelegationToken` (`verify/credential.ts`).

## Verification pipeline (`POST /v1/envelopes`)

Per envelope, in order — **no bridge call, no Self proof** at answer time:

1. Parse with zod (`.strict()`). Schema-invalid bodies return 422.
2. Verify the broker's own signature on the `delegation_token` + `expires_at > now()`
   (`verify/delegation.ts` → `verify/credential.ts`).
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
`HEARME_BROKER_EXPOSE_REJECTION_REASONS=false`** so the broker is not an
oracle for which bit of an envelope went wrong.

## Self on-chain invalidations

Because Self proofs are verified once at registration, the broker runs an
optional background listener (`src/selfRevocations.ts`) for Self on-chain
invalidation/update events. When a configured event emits an old nullifier, the
broker records it in `self_nullifier_invalidations`, sets
`registrations.revoked_at`, deletes accepted envelopes from that nullifier, and
recomputes each affected aggregate in the same transaction. ABI-driven by env
vars; disabled until the concrete Self event name/topic is supplied.

## Wire formats & cross-language compatibility

Exactly mirror `packages/proto/{delegation,envelope,revocation,question}.json`
and stay byte-for-byte compatible with the `hearme-skill` agent:

- JSON keys are snake_case on the wire (`question_id`, `unique_identifier`,
  `disclosed_predicates`, …).
- `POST /v1/envelopes` accepts exactly five top-level fields; `POST
  /v1/envelopes/revoke` exactly three. Extra fields are rejected (§12).
- `canonical_json` (`verify/canonical.ts`) is sorted-keys, compact-separator
  JSON. `DelegationToken` timestamps are kept as strings end-to-end so the
  signed payload equals the wire bytes (no `Date` round-trip).
- The agent signs `SHA-256(question_id || answer || nonce || delegation_hash)`
  with the four parts joined by a literal ASCII `|`. Pinned in
  `verify/envelope.ts::envelopeSigningInput` and mirrored by the skill.

These invariants are locked by golden vectors recorded from the original Python
broker in `tests/goldens.test.ts` (canonical bytes, `delegation_hash`, the
broker signature, envelope/revocation digests, predicate derivation).

## Database role grants required

The broker connects as `hearme_broker`, defined by `db/init/02-roles.sh` with
`SELECT/INSERT/UPDATE` on `envelopes`, `aggregates`, `registrations`,
`self_nullifier_invalidations`, `self_chain_cursors`; `SELECT/INSERT` on
`revocations`; `SELECT/UPDATE` on `questions`; `SELECT` on `askers`. The broker
**cannot** INSERT or DELETE `questions` or `askers`; seed test data as
`hearme_admin`.

## Tests

```bash
cd packages/broker
npm ci
npm run typecheck     # tsc --noEmit
npm test              # vitest run
```

- `tests/goldens.test.ts` and `tests/unit.test.ts` are pure / in-process — no Docker.
- `tests/db.test.ts` spins up an ephemeral Postgres 16 via
  [`@testcontainers/postgresql`](https://node.testcontainers.org/) and applies the
  schema (the generated migrations under `packages/web/drizzle/migrations/`, plus
  pgcrypto). It skips cleanly when Docker is unavailable.

## Layout

```
packages/broker/
├── package.json
├── tsconfig.json · tsup.config.ts · vitest.config.ts
├── Dockerfile
├── README.md
├── src/
│   ├── server.ts                # Fastify app factory + lifecycle
│   ├── config.ts                # env-driven settings
│   ├── db.ts                    # postgres-js + Drizzle lifecycle
│   ├── schema.ts                # re-export of packages/web/src/db/schema.ts
│   ├── models.ts                # zod wire schemas (.strict()) + RejectionReason
│   ├── queries.ts               # all SQL (parameterized)
│   ├── aggregates.ts            # answer classification + per-predicate tallies
│   ├── eligibility.ts           # signed-predicate scope eligibility
│   ├── ratelimit.ts             # sliding-window limiter + Fastify hook
│   ├── startupChecks.ts         # refuse prod boot on dev defaults
│   ├── selfRevocations.ts       # Self on-chain invalidation listener
│   ├── routes/                  # questions · register · envelopes · revocations · stats · dev
│   └── verify/
│       ├── canonical.ts         # deterministic JSON + SHA-256
│       ├── credential.ts        # issue + verify the broker-signed DelegationToken
│       ├── delegation.ts        # per-envelope: broker sig + expiry
│       ├── envelope.ts          # agent signature + linkage
│       ├── bridgeClient.ts      # HTTP client for the self-bridge
│       ├── selfIdentity.ts      # registration: SNARK check (via bridge) + bindings
│       └── predicates.ts        # country→region, thresholds→age_band
└── tests/                       # goldens · unit · db (+ helpers, pg fixture)
```
