# Production deployment — hearme v0

> Operational runbook for shipping the v0 stack. Covers what to set, what to
> rotate, how to back up, and how to verify the loop end-to-end on real Self
> proofs. Pairs with the architectural rationale in `ARCHITECTURE_V0.md` and the
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

### 1.1 Where the secrets live: AWS SSM Parameter Store

The deployed boxes (staging + prod, both EC2 in `eu-central-1`) do **not** keep
a hand-maintained `.env` as the source of truth. Every secret lives in **AWS
SSM Parameter Store** under a per-env path:

| Path | Type | Holds |
|---|---|---|
| `/hearme/staging/HEARME_STAGING_*` | `SecureString` (passwords, signing key, OpenRouter key) / `String` (host, callback URL) | staging |
| `/hearme/prod/HEARME_PROD_*` | same split | prod |

The leaf of each path is the **exact** env var name the compose overlays
reference (`docker-compose.staging.yml` / `docker-compose.prod.yml`), so the
on-box `.env` is just a projection of `/hearme/<env>/*`. The full key list per
env is in `staging.env.example` / `prod.env.example`. For the exact workflow to
add a new parameter and wire it into compose, see `docs/ADDING_SSM_SECRET.md`.

**Seed / rotate** — fill a local copy of the example file, push it, delete it:

```sh
scripts/push-secrets-to-ssm.sh staging ./staging.env   # or: prod ./prod.env
shred -u ./staging.env
```

Then redeploy so the box picks up the new value.

**Staging deploy** renders the secrets automatically: `deploy-staging.yml`
streams `scripts/render-secrets-env.sh staging` onto the box as `~/hearme/.env`
before `docker compose up` (the runner already holds the `hearme-staging` AWS
creds). Rotating a staging secret = change it in SSM, then push to `main` (or
re-run the workflow).

**Prod deploy is manual** — render the `.env` onto the box yourself, then bring
the stack up. Pin the images to the commit's SHA and record last-known-good
(the same deploy-safety machinery staging uses — §7) so prod is also rollable:

```sh
scripts/render-secrets-env.sh prod \
  | ssh -i ~/.ssh/hearme-prod.pem ubuntu@<prod-ip> 'umask 077; cat > ~/hearme/.env'
ssh -i ~/.ssh/hearme-prod.pem ubuntu@<prod-ip> bash -se <<'EOF'
  cd ~/hearme && git pull
  export HEARME_DEPLOY_SHA="$(git rev-parse --short=12 HEAD)"
  docker compose -f docker-compose.prod.yml up -d --build --remove-orphans
  scripts/healthgate.sh                 # fail here = do NOT finalize; rollback stays valid
  scripts/deploy-finalize.sh prod       # records .deploy-state, prunes stale images
EOF
```

`docker-compose.prod.yml` is a **standalone** file (it `extends` the base
services internally), so prod uses a single `-f` — not the `-f base -f overlay`
pair staging uses. Prod's database is **AWS RDS**, not an on-box container, so
the prod file defines no `postgres` service and the DSNs target
`${HEARME_PROD_POSTGRES_HOST}`. First-time RDS provisioning + bootstrap is §4;
SHA-pinned images / rollback (§7) are unchanged.

**IAM** — the principal that renders secrets needs, scoped to its env's path:

```
ssm:GetParametersByPath   arn:aws:ssm:eu-central-1:<acct>:parameter/hearme/<env>/*
kms:Decrypt               the key SSM used (alias/aws/ssm by default)
```

`push-secrets-to-ssm.sh` additionally needs `ssm:PutParameter` + `kms:Encrypt`.
The staging deploy uses the `hearme-staging` IAM user (already wired into
`deploy-staging.yml`); prod rendering uses your operator credentials.

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

### 3.1 Frozen constants — never change in prod

Some values are **load-bearing for the identity graph and irreversible once
live**. Changing them after launch does not error — it silently re-mints every
identity. They are frozen for the life of an environment's data:

| Constant | Frozen value (prod) | Env / staging | Defined in | Why it can never change |
|----------|--------------------|---------------|------------|-------------------------|
| **Self scope** (nullifier) | `hearme-v1` | `SELF_SCOPE` (staging: `staging-hearme-v1`) | `packages/self-bridge/src/scope.js` → `PRODUCTION_SCOPE` | The Self circuit hashes the scope into every nullifier (`unique_identifier`). A new scope gives every existing passport a brand-new identity: Sybil resistance resets, every `registrations` row orphans, and every per-question voter tag stops matching. There is no migration path — old nullifiers cannot be re-derived. (GH #97) |
| **Broker credential `scope`** | `hearme-v1` | `HEARME_BROKER_SELF_SCOPE` (staging: `staging-hearme-v1`) | `packages/broker/src/verify/scope.ts` → `PRODUCTION_SCOPE` | Stamped into every DelegationToken / asker-session, bound into the broker signature, and checked against incoming credentials (`verify/delegation.ts`, `SELF_SCOPE_MISMATCH`). **Must equal the env's Self scope.** Together with the per-env signing key, it is what keeps a staging credential from ever being accepted by prod. |

The two scopes **must match within an environment** (prod `hearme-v1` ↔
`hearme-v1`; staging `staging-hearme-v1` ↔ `staging-hearme-v1`).

How the freeze is enforced (both bridge and broker, identical pattern):

- **Production ignores the env var entirely.** With `SELF_PRODUCTION_MODE=1`
  (bridge) / `HEARME_BROKER_PRODUCTION_MODE=1` (broker), the scope is pinned to
  `PRODUCTION_SCOPE` in code and `SELF_SCOPE` / `HEARME_BROKER_SELF_SCOPE` is
  ignored (a loud warning is logged if one is set). A dropped/typo'd/edited env
  var therefore **cannot** re-mint identities — the worst case is a warning, not
  a silent identity reset (fail-safe).
- **Staging uses a distinct frozen scope.** `docker-compose.staging.yml` pins
  `SELF_SCOPE=staging-hearme-v1` and `HEARME_BROKER_SELF_SCOPE=staging-hearme-v1`
  so staging's mock-passport identities and credentials can never collide with
  prod. Equally frozen for staging's data. *(Adopting a distinct staging scope is
  a one-time reset of staging's existing identity graph — fine pre-launch.)*
- **Local dev** uses `hearme-v1` from `docker-compose.yml` (mock passports +
  throwaway dev DB, so no collision with prod).

To intentionally start a fresh identity generation (a true `v2`), you bump
`PRODUCTION_SCOPE` in **both** `scope.js` (bridge) and `scope.ts` (broker)
together, and accept that every user must re-register. That is a deliberate,
breaking migration — never a config tweak.

---

## 4. Database: managed Postgres (RDS) + backups

Prod's Postgres holds the entire system of record: `registrations`,
`envelopes`, `aggregates`. Losing `registrations` is **irreversible** — it
binds each Self nullifier to an agent key, so a wipe forces every user to
re-scan their passport (a relaunch, not a recovery). Durability is therefore
not optional, and prod runs the database on **AWS RDS**, not an on-box
container, precisely so backups are automated and stored off-box.

> Staging and local dev still use the container Postgres in
> `docker-compose.yml`. Only **prod** points at RDS — that's why
> `docker-compose.prod.yml` is a standalone file with no `postgres` service
> (§1.1).

### 4.1 What RDS gives you (vs. the old on-box volume)

| | On-box container (old) | RDS (now) |
|---|---|---|
| Backups | a cron you must remember to add | **automated daily**, managed |
| Off-box copy | a step you had to tailor yourself | **always** (AWS-managed S3) |
| Recovery point | last nightly dump → up to 24h loss | **point-in-time, to the second** within the retention window |
| Instance dies | total loss | restore from automated backup/snapshot |

`scripts/provision-rds.sh` creates the instance: single-AZ `db.t4g.micro`,
encrypted, **not publicly accessible**, deletion-protection on, **7-day**
automated backups + point-in-time recovery (PITR). Single-AZ keeps cost low and
already covers the durability requirement; Multi-AZ (HA standby + auto-failover)
is a separate availability decision that does not change the backup story.

> **AWS Free plan caps retention.** A restricted Free-plan account rejects the
> 7-day default (`FreeTierRestrictionError: backup retention period exceeds the
> maximum`). Pass `--retention-days 1` to provision now (still automated +
> off-box + 1-day PITR — a large step up from a single volume), then raise it
> after upgrading the plan, with no downtime:
> `aws rds modify-db-instance --db-instance-identifier hearme-prod --backup-retention-period 7 --apply-immediately`.

### 4.2 First-time provisioning + bootstrap

One-time, from a workstation with AWS creds (`rds:CreateDBInstance`, and SSM
read/write on `/hearme/prod/*`):

```sh
# 0. Master password must already be in SSM (push-secrets-to-ssm.sh prod ...).
# 1. Create the instance and record its endpoint in SSM as HEARME_PROD_POSTGRES_HOST.
scripts/provision-rds.sh \
  --subnet-group hearme-db-subnets \   # DB subnet group over the VPC's private subnets
  --security-group sg-0abc123 \        # SG that allows 5432 FROM the EC2 box's SG
  --push-ssm

# 2. On the prod box: render the .env (now incl. HEARME_PROD_POSTGRES_HOST) and
#    bootstrap the empty DB — pgcrypto, schema (migrator), roles + grants.
scripts/render-secrets-env.sh prod | ssh prod 'umask 077; cat > ~/hearme/.env'
ssh prod 'cd ~/hearme && git pull && scripts/bootstrap-rds.sh'
```

`bootstrap-rds.sh` is idempotent and applies the **same** role/grant boundary as
local dev — both run `db/init/roles.sql`, which `scripts/verify-db.sh` guards in
CI. After it succeeds, bring the stack up normally (§1.1).

### 4.3 Cutover from an existing on-box database

If the prod box is already live on the container Postgres, migrate its rows into
RDS **before** switching. Bootstrap (§4.2) already created the schema + roles on
RDS, so you load **data only** — but two RDS facts shape *how*, and the obvious
`pg_restore --data-only --disable-triggers` does **not** work:

- **RDS forces TLS** (`rds.force_ssl=1`) — every connection needs
  `sslmode=require` (the prod compose DSNs already carry it; pass it explicitly
  for ad-hoc `psql`/`pg_restore`).
- **The RDS master is `rds_superuser`, not a true superuser**, so
  `--disable-triggers` (`ALTER TABLE … DISABLE TRIGGER ALL`) is **refused**
  (`permission denied: … is a system trigger`). Without trigger disabling a
  data-only load enforces FKs and fails on table order (children load before
  parents). The fix the master *is* allowed to use: `SET session_replication_role
  = replica`, which defers FK enforcement for the load session.

Dump the on-box data — a full custom dump, **excluding the migration ledger** so
it doesn't collide with the one bootstrap already wrote:

```sh
# On the prod box, old stack still running:
docker exec hearme-postgres pg_dump -U hearme_admin -Fc --no-owner --no-privileges \
  --exclude-table=_schema_migrations hearme > /tmp/cutover.dump
```

Quiesce writers (so nothing is lost between dump and switch), then load in one
transaction. It is atomic: if the `SET` is denied or any `COPY` fails, the whole
load — including the `TRUNCATE` — rolls back, leaving no partial state:

```sh
docker stop hearme-broker hearme-web hearme-classifier
set -a; . ~/hearme/.env; set +a
PGH="$HEARME_PROD_POSTGRES_HOST"; ADMINPW="$HEARME_PROD_POSTGRES_ADMIN_PASSWORD"

{ echo "SET session_replication_role = replica;"
  echo "TRUNCATE aggregates,askers,envelopes,questions,registrations,revocations,self_chain_cursors,self_nullifier_invalidations RESTART IDENTITY CASCADE;"
  docker run --rm -v /tmp/cutover.dump:/cutover.dump:ro postgres:16 \
    pg_restore --data-only --no-owner --no-privileges -f - /cutover.dump
} | docker run --rm -i --network host -e PGPASSWORD="$ADMINPW" postgres:16 \
    psql "host=$PGH user=hearme_admin dbname=hearme sslmode=require" \
      -v ON_ERROR_STOP=1 --single-transaction
```

(`pg_restore … -f -` writes the data section to stdout; piping it through `psql`
in the same session as the `SET` is what lets FK enforcement stay deferred —
`pg_restore` itself can't set the role.)

Verify row counts match between the on-box DB and RDS, **then** switch (§1.1):

```sh
cd ~/hearme
export HEARME_DEPLOY_SHA="$(git rev-parse --short=12 HEAD)"
docker compose -f docker-compose.prod.yml up -d --build --remove-orphans
scripts/healthgate.sh && scripts/deploy-finalize.sh prod
shred -u /tmp/cutover.dump
```

`--remove-orphans` retires the old `hearme-postgres` container. Keep its Docker
volume (`hearme-pgdata`) until RDS is confirmed serving — it is your rollback.

> **Additive migrations make this safe even when prod is behind.** Columns a
> later migration adds (e.g. `0005`'s `answer_count`/`signal_count`) take their
> `DEFAULT` on the restored rows, because the old dump's `COPY` column list
> omits them. A *destructive* migration would need a different plan — see §7.

### 4.4 Restore drill (do this once before launch)

Managed backups you have never restored are untested backups. Pick the method
your account allows:

**RDS-native (gold standard).** Point-in-time restore to a throwaway instance
(RDS never overwrites the source):

```sh
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier hearme-prod \
  --target-db-instance-identifier hearme-restore-drill \
  --use-latest-restorable-time \
  --db-subnet-group-name hearme-db-subnets \
  --vpc-security-group-ids <rds-sg> --no-publicly-accessible
aws rds wait db-instance-available --db-instance-identifier hearme-restore-drill
# psql to the restored endpoint, confirm the 8 tables + row counts, then:
aws rds delete-db-instance --db-instance-identifier hearme-restore-drill --skip-final-snapshot
```

This spins a **second** instance. On a restricted **AWS Free plan** that is
blocked or billable (the same plan caps backup retention — §4.1), so run it
after upgrading the plan.

**Logical (free, no second instance).** Dump RDS and restore into a throwaway
local Postgres container, then sanity-check the schema + row counts (the
managed-Postgres analogue of `scripts/verify-db.sh`, which targets the local
container):

```sh
set -a; . ~/hearme/.env; set +a
docker run --rm --network host -e PGPASSWORD="$HEARME_PROD_POSTGRES_ADMIN_PASSWORD" \
  postgres:16 pg_dump -h "$HEARME_PROD_POSTGRES_HOST" -U hearme_admin \
  -Fc --no-owner --no-privileges hearme > /tmp/drill.dump
# spin a scratch container, restore, count rows, throw it away:
docker run -d --name pg-drill -e POSTGRES_PASSWORD=x postgres:16 >/dev/null
sleep 5 && docker cp /tmp/drill.dump pg-drill:/drill.dump
docker exec -e PGPASSWORD=x pg-drill createdb -U postgres hearme
docker exec -e PGPASSWORD=x pg-drill pg_restore -U postgres -d hearme --no-owner /drill.dump
docker exec -e PGPASSWORD=x pg-drill psql -U postgres -d hearme -c "\dt"
docker rm -f pg-drill && rm -f /tmp/drill.dump
```

### 4.5 Logical dumps (`scripts/backup-db.sh`) — now optional

RDS owns durability, so `scripts/backup-db.sh` is no longer the critical path
and does **not** need a cron. It remains useful for ad-hoc, portable
`pg_dump --format=custom` exports — pre-migration snapshots, cross-account
copies, or a local restore drill. Run it against the RDS endpoint with the
standard libpq env vars when you want one.

### 4.6 Retention

Nothing prunes `envelopes` today. At v0 scale that is fine; once the table
exceeds the working-set RAM you will want a partitioning or archival step.
Aggregates are derived (the self-revocations path recomputes them after a
delete), so envelopes are the only must-keep.

---

## 5. Observability

The **broker** is wired for production observability (issue #101); web,
self-bridge, and the classifier are follow-ups (their liveness is already
covered — see below). Three pieces:

1. **Structured logs.** The broker's pino logger emits newline-delimited JSON
   with a `service: "broker"` field, an env-tunable level
   (`HEARME_BROKER_LOG_LEVEL`, default `info`), and redaction of the
   `Authorization`/`Cookie` request headers (`packages/broker/src/logging.ts`).
   Pipe stdout to your log backend.
2. **Liveness.** `GET /healthz` returns `{"status":"ok"}` — the orchestrator
   restarts on non-200, and the monitoring stack alerts on it (below).
3. **Metrics.** The broker serves Prometheus text at `GET /metrics` on `:8000`
   (`packages/broker/src/observability/metrics.ts`). It is **internal-only** —
   the Caddyfile routes only `/v1/*`, `/self/*`, and the web default, so
   `/metrics` is never internet-reachable; Prometheus scrapes it over the
   compose network. Series: `hearme_broker_register_total{outcome}`,
   `…envelopes_total{outcome}`, `…revoke_total{outcome}` (register / ingest /
   revoke rate), `…rejections_total{route,reason}` (verification-failure
   breakdown by `RejectionReason`), `…ratelimited_total{route}` (429 rate), plus
   default Node process metrics. Disable with `HEARME_BROKER_METRICS_ENABLED=0`.
4. **Error tracking.** The broker forwards unhandled exceptions (per-request and
   process-level) to **Sentry** when `SENTRY_DSN` is set
   (`packages/broker/src/observability/sentry.ts`). It is **env-gated**: with no
   DSN it is a silent no-op, so it ships safely before a Sentry project exists.
   Wire the DSN via `HEARME_PROD_SENTRY_DSN` (see `prod.env.example`).

### Running the monitoring stack

Prometheus + Alertmanager + blackbox-exporter + Grafana ship as an **optional
compose overlay** (`docker-compose.monitoring.yml`, configs under `monitoring/`):

```sh
docker compose -f docker-compose.prod.yml -f docker-compose.monitoring.yml up -d
```

All four UIs bind to loopback only (reach them over an SSH tunnel). Alerts
(`monitoring/prometheus/alerts.yml`): **broker/self-bridge down** (the latter via
a blackbox `/healthz` probe, since the bridge has no `/metrics` yet),
**error-rate spikes** (majority of register/envelope requests rejected), and
**sustained 429 pressure**. Alertmanager ships a no-op receiver — wire a
Slack/webhook destination to actually page (`monitoring/alertmanager/alertmanager.yml`).
Full details and the follow-up list (native `/metrics` + Sentry for the other
three services, classifier-backlog gauge) are in `monitoring/README.md`.

Don't enable `HEARME_BROKER_EXPOSE_REJECTION_REASONS=1` in production "just
so logs are friendlier" — the same string the operator reads is the string
the *attacker* reads (it answers "which bit of my forged envelope was
wrong"). The reason is recorded internally (logs + `…rejections_total`); the
external ack stays generic.

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
- [ ] Self scope is frozen: prod runs with `SELF_PRODUCTION_MODE=1` (so the
      scope is pinned to `hearme-v1` in code and `SELF_SCOPE` is ignored), and
      `GET /healthz` on the bridge reports `"scope":"hearme-v1"`. This value is
      **permanent** — see §3.1 Frozen constants.
- [ ] `SELF_CELO_RPC_URL` set and a hand `curl` against it succeeds.
- [ ] Caddy or your reverse proxy sets `X-Real-IP` for both broker and web
      (rate limit cannot otherwise distinguish clients).
- [ ] Prod DB is on RDS (`scripts/provision-rds.sh`), with automated backups +
      PITR on, and the restore drill (§4.4) has been performed once.
- [ ] Broker `GET /healthz` and web `GET /api/healthz` are monitored.
- [ ] Observability is up (§5): the monitoring overlay is running, Prometheus is
      scraping `broker:8000/metrics`, the down/error-rate alerts have a real
      Alertmanager destination, and `HEARME_PROD_SENTRY_DSN` is set (or you have
      consciously deferred error tracking).
- [ ] A rollback has been rehearsed once: `scripts/rollback.sh` returns the box
      to the previous good SHA and the health gate passes (§7).
- [ ] One full end-to-end run on real passports: enrol with a real Self
      proof; ask a question via `/ask`; an onboarded skill answers it;
      verify the answer appears in the aggregate.

If any row is unchecked, you are not in production posture yet.

---

## 7. Rollback & deploy safety

The v0 deploy is build-on-box: the workflow (staging) or an operator (prod)
SSHes in, `git reset --hard`s to a commit, and runs `docker compose up`. There
is no image registry. Deploy safety is therefore built from three pieces that
all live in the repo:

**1. Images are pinned to an immutable git-SHA tag — never `:latest`.**
`docker-compose.yml` tags every built service as `hearme-<svc>:${HEARME_DEPLOY_SHA}`
(`broker`, `self-bridge`, `web`, `migrator`, `classifier`). The deploy exports
`HEARME_DEPLOY_SHA=$(git rev-parse --short=12 HEAD)` before `up`, so each deploy
leaves a **named, immutable image for that commit** on the box. Local `docker
compose up` (no `HEARME_DEPLOY_SHA`) falls back to the `dev` tag — unchanged dev
ergonomics.

**2. The last-known-good SHA is recorded — but only after a health gate.**
After `up`, the deploy runs `scripts/healthgate.sh`, which polls the broker's
`/healthz` and the web's `/api/healthz` (both on loopback) until they answer or
it times out. A failed gate fails the deploy and `scripts/deploy-finalize.sh`
**does not run** — so `.deploy-state` (on the box, next to `.env`) still records
the *previous* good SHA. Only a healthy deploy advances it:

```
LAST_GOOD_SHA=<running, verified>
PREVIOUS_GOOD_SHA=<the SHA it replaced — rollback's default target>
ENV=staging|prod
DEPLOYED_AT=<UTC>
```

`deploy-finalize` also prunes old `hearme-*` image tags, keeping the current and
previous good SHAs (so a rollback need not rebuild) plus `dev`.

**3. One-command rollback.** On the box:

```sh
scripts/rollback.sh            # back to PREVIOUS_GOOD_SHA from .deploy-state
scripts/rollback.sh <git-sha>  # back to a specific commit
```

It checks out the target SHA and `docker compose up -d`s pinned to that SHA's
images. If the previous build's images are still present (the common case — see
piece 2) it does **not** rebuild, so recovery is seconds and does not depend on
the target source even compiling; if they were pruned it falls back to `--build`.
A health gate then confirms the rolled-back stack answers before it declares
success. The script reads its whole body into memory before touching git and
inlines its health check, so it is safe even rolling back to a commit that
predates these scripts.

For staging, the fastest path is usually just to **revert the bad commit on
`main`** — that re-runs `deploy-staging.yml` and ships a new good SHA forward.
`rollback.sh` is for when you need the box healthy *now*, before a revert lands.

### Migrations are forward-only — code rollback ≠ schema rollback

`scripts/migrate.mjs` only ever rolls **forward**: it applies `*.sql` files in
`packages/web/drizzle/migrations/` that aren't yet in `_schema_migrations` and
never generates or runs a down-migration (Drizzle's `generate` is
forward-only). Rolling back code does **not** undo a migration. So when a bad
deploy included a schema change, decide by migration shape:

- **Additive / backward-compatible** (new table, new nullable column, new
  index): safe to roll back under. The old code simply ignores what it doesn't
  know about; the extra schema is inert. This is the great majority of
  migrations and the reason additive-only is the house style.
- **Destructive / rewriting** (dropped or renamed column, narrowed type,
  backfill that drops data): a code rollback alone leaves old code running
  against a schema it can't satisfy, *and* the data may already be gone. There
  is no forward-only un-migrate. Recover the **database** from the most recent
  backup (§4) — `pg_restore` into a fresh DB, point the stack at it — then roll
  the code back to match. Plan for this before shipping a destructive migration:
  take a fresh backup immediately before the deploy.

Practically: keep migrations additive and ship the schema change one deploy
*ahead* of the code that requires it (expand, then contract). Then a code
rollback is always a clean `scripts/rollback.sh` with no DB involvement.

### Downtime

The single-host, single-replica v0 shape (§1, top) cannot do true zero-downtime
deploys: each service has a fixed `container_name`, so `up` recreates it in
place and there is a brief gap while the new container boots. Two things keep
that gap small and safe rather than eliminating it:

- **Dependency ordering already gates the risky steps.** `web`, `broker`, and
  `classifier` declare `depends_on: { migrator: service_completed_successfully,
  postgres: service_healthy }`, so the app containers are not recreated until
  migrations have applied and Postgres is healthy. A failed migration aborts
  the deploy *before* the app is touched.
- **The health gate bounds the blast radius.** If the new container doesn't come
  healthy, the deploy is marked failed and the last-good marker isn't advanced,
  so the recovery target is unambiguous.

True zero-downtime (rolling/blue-green, a second replica behind Caddy) is a
v0.2 concern and also interacts with the in-memory rate limiters (§2).
