# Production deployment — hearme v0

> Operational runbook for shipping the v0 stack. Covers what to set, what to
> rotate, how to back up, and how to verify the loop end-to-end on real Self
> proofs. Pairs with the architectural rationale in `ARCHITECTURE.md` and the
> "what v0 skips" list in §11 — that is the *design* boundary; this doc is the
> *operational* boundary.

The v0 deployment shape is a **single host running Caddy → docker-compose
(postgres + broker + web + self-bridge)**. Nothing in the codebase assumes
multiple replicas; horizontal scaling is a v0.2 concern and changes a few
assumptions called out below (the in-memory rate limiters in particular).

---

## 1. What ships with safe defaults vs. what you MUST set

The repo ships dev defaults so a fresh `scripts/dev-up.sh` works out of the
box. Those defaults are catastrophic in production: a dev signing key lets
anyone forge a `DelegationToken`; the dev-bypass route mints identities with no
Self proof at all. The broker **refuses to start** when
`HEARME_BROKER_PRODUCTION_MODE=1` is set and any documented dev default is
still present (see `packages/broker/src/startupChecks.ts`).
Failing closed is the only safe default; do not paper over this with a flag.

> **Behaviour gap, follow-up.** This TS port uses the **opt-in
> `HEARME_BROKER_PRODUCTION_MODE`** toggle. The
> *fail-closed-by-default + opt-in `HEARME_BROKER_DEV_MODE`* inversion that
> landed on `main` in #62 has **not** been ported here, so forgetting the env
> var in production does **not** fail closed — the checks simply don't run.
> Until #62 is ported to TS, prod compose **must** set
> `HEARME_BROKER_PRODUCTION_MODE: "1"` (already done in `docker-compose.prod.yml`).

The full pre-flight list (the broker checks each on startup when
`HEARME_BROKER_PRODUCTION_MODE=1`):

| Env var | Dev default | Production value |
|---|---|---|
| `HEARME_BROKER_PRODUCTION_MODE` | unset | **`1`** (without this, checks below do not run) |
| `HEARME_BROKER_SIGNING_KEY` | published dev seed | a fresh 32-byte Ed25519 seed (base64), in your secret manager |
| `HEARME_BROKER_DATABASE_URL` | `…hearme_broker_dev@localhost…` | rotated password, internal DSN |
| `HEARME_BROKER_DEV_INSECURE_REGISTER` | `false` | **stays `false`** (mounts `/v1/dev/register` if `true`) |
| `HEARME_BROKER_REQUIRE_REGISTRY_CONFIRMATION` | `true` | **stays `true`** (the one-time Celo registry/root check, §5) |
| `HEARME_BROKER_EXPOSE_REJECTION_REASONS` | `true` | **`false`** (otherwise the broker is a verification oracle) |
| `HEARME_BROKER_SELF_BRIDGE_URL` | `http://localhost:8787` | same-host sidecar (warning) or internal URL |
| `SELF_MOCK_PASSPORT` (self-bridge) | `1` (staging) | **`0`** (mainnet, real passports) |
| `SELF_CELO_RPC_URL` (self-bridge) | unset | a Celo mainnet RPC URL |

Read the broker README for the per-variable semantics; this table is the
list to *check*, not to *understand*.

Generate the broker signing key:

```sh
python3 -c 'import os, base64; print(base64.b64encode(os.urandom(32)).decode())'
```

Stash that in your secret manager (KMS / Doppler / Vault / sealed-secret), pin
it to the broker container env, and rotate it only with an overlap window —
ARCHITECTURE §13 lists this as the broker-signing-key open question; until
rotation is automated, plan downtime + force re-registration of all live
delegations on key change.

---

## 2. Rate limiting (already on by default)

The broker and the web app each ship with **in-memory, per-process sliding-
window rate limits** on the write endpoints (PR introduced
`packages/broker/src/ratelimit.ts` and
`packages/web/src/lib/rate-limit.ts`). The defaults:

| What | Default | Override |
|---|---|---|
| `POST /v1/register` | 3/hour | `HEARME_BROKER_RATELIMIT_REGISTER_PER_HOUR` |
| `POST /v1/envelopes` | 30/min | `HEARME_BROKER_RATELIMIT_ENVELOPES_PER_MINUTE` |
| `POST /v1/envelopes/revoke` | 10/min | `HEARME_BROKER_RATELIMIT_REVOKE_PER_MINUTE` |
| `/ask` question creation | 5/hour | `HEARME_WEB_RATELIMIT_QUESTIONS_PER_HOUR` |

Header trust is on by default because the v0 shape is **Caddy → app**; set
`HEARME_BROKER_RATELIMIT_TRUST_PROXY_HEADERS=false` and `HEARME_WEB_TRUST_PROXY_HEADERS=false`
**only** if you ever expose either service directly. Otherwise any client can
forge `X-Real-IP` and bypass the limit.

**Two-replica caveat.** The limiter is per-process. Once you run two
replicas of either service, the effective limit doubles per honest user
*and* a flooder can hit each replica independently. Either pin to a single
replica (the v0 default), or replace the in-memory backing with Redis — the
limiter's `RateLimiter`/`checkRateLimit` API stays the same.

---

## 3. Real Self (passports, mainnet)

The self-bridge defaults to `SELF_MOCK_PASSPORT=1` so staging accepts the
Self app's mock-passport flow. The whole point of personhood is real
passports, so:

1. Set `SELF_MOCK_PASSPORT=0` on the bridge.
2. Set `SELF_CELO_RPC_URL` to a Celo **mainnet** RPC endpoint (an Infura /
   Alchemy / public node URL).
3. Keep `HEARME_BROKER_REQUIRE_REGISTRY_CONFIRMATION=true` so the broker
   rejects any registration whose Merkle root isn't current on Celo.

Verify the chain dependency before going live:

```sh
# from the bridge container
curl -sS "$SELF_CELO_RPC_URL" \
  -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
```

A non-error JSON response with a fresh `result` is the floor. If this fails
in production, registration fails for *everyone* — the bridge is on the
critical path for the entire `POST /v1/register` flow.

---

## 4. Backups + retention

The shared Postgres holds the entire system of record: registrations,
envelopes, aggregates. There is no other replica.

A minimal nightly backup script ships at `scripts/backup-db.sh` (set
`BACKUP_DIR` and a cron entry; `pg_dump --format=custom` into
`$BACKUP_DIR/hearme-YYYYMMDD.dump`). Pair it with whatever offsite
replication your environment uses (S3 lifecycle, restic, borg); the script
deliberately does **not** ship the offsite step, because it is the part you
must tailor.

Restore drill: confirm at least once before going live that

```sh
pg_restore -d hearme-restored "$BACKUP_DIR/hearme-YYYY-MM-DD.dump"
```

produces a DB that `scripts/verify-db.sh` accepts.

Retention: nothing prunes envelopes today. At v0 scale that is fine; once
the table exceeds the working-set RAM you will want a partitioning or
archival step. Aggregates are derived (the self-revocations path
recomputes them after a delete), so envelopes are the only must-keep.

---

## 5. Observability minimum

Logs are the only thing wired in v0 (`logging.basicConfig(level=INFO)` in
`broker/main.py`). For a real deployment, at minimum:

1. **Structured logs.** Switch the broker formatter to JSON (the broker
   already emits `route=…`, `client=…` style key-value pairs in the
   rate-limiter; the rest of the codebase is human-readable). Pipe to your
   log backend.
2. **Liveness.** `GET /healthz` already returns `{"status":"ok"}`. Have
   the orchestrator restart on non-200.
3. **Counters you want.** Envelope ingest rate, registration rate, dispatch
   lag (the gap between `questions.created_at` and the median envelope
   `submitted_at`), 429 rate (rate-limit pressure), 4xx rate by reason
   (verification-pipeline pressure). The broker emits enough log lines today
   to count these via your log backend; a `prometheus_client` middleware is
   the v0.1 follow-up.

Don't enable `HEARME_BROKER_EXPOSE_REJECTION_REASONS=1` in production "just
so logs are friendlier" — the same string the operator reads is the string
the *attacker* reads (it answers "which bit of my forged envelope was
wrong"). Log the reason internally; emit a generic ack externally.

---

## 6. Pre-launch checklist (one page)

Run through this before flipping the public DNS:

- [ ] `HEARME_BROKER_PRODUCTION_MODE=1` is set; broker boots without raising
      `ProductionConfigError`. *(Note: in this TS port the checks are opt-in,
      not fail-closed-by-default — see the gap note in §1. Forgetting the env
      var silently skips them.)*
- [ ] `HEARME_BROKER_SIGNING_KEY` is a freshly generated 32-byte seed, stored
      only in the secret manager and the broker process env.
- [ ] `HEARME_BROKER_DATABASE_URL` uses a non-dev password.
- [ ] `HEARME_BROKER_EXPOSE_REJECTION_REASONS=false`.
- [ ] `HEARME_BROKER_DEV_INSECURE_REGISTER=false` (or unset).
- [ ] `HEARME_BROKER_REQUIRE_REGISTRY_CONFIRMATION=true`.
- [ ] `SELF_MOCK_PASSPORT=0` on the self-bridge.
- [ ] `SELF_CELO_RPC_URL` set and a hand `curl` against it succeeds.
- [ ] Caddy or your reverse proxy sets `X-Real-IP` for both broker and web
      (rate limit cannot otherwise distinguish clients).
- [ ] `scripts/backup-db.sh` is scheduled, and a restore has been tested
      against a throwaway DB.
- [ ] `GET /healthz` is monitored.
- [ ] One full end-to-end run on real passports: enrol with a real Self
      proof; ask a question via `/ask`; an onboarded skill answers it;
      verify the answer appears in the aggregate.

If any row is unchecked, you are not in production posture yet.
