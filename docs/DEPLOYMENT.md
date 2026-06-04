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
RDS **before** switching, or you re-create exactly the data-loss risk this move
exists to remove:

```sh
# On the prod box, with the old stack still running:
docker exec hearme-postgres pg_dump --format=custom --no-owner --no-privileges \
  -U hearme_admin hearme > /tmp/cutover.dump

# After provision + bootstrap (4.2) created the schema + roles on RDS, load the
# DATA only (schema already exists; --no-owner/--no-privileges keeps it portable):
docker run --rm --network host -e PGPASSWORD="$HEARME_PROD_POSTGRES_ADMIN_PASSWORD" \
  -v /tmp/cutover.dump:/cutover.dump:ro postgres:16 \
  pg_restore --no-owner --no-privileges --data-only --disable-triggers \
    -h "$HEARME_PROD_POSTGRES_HOST" -U hearme_admin -d hearme /cutover.dump

# Sanity-check row counts match, THEN switch the deploy to the RDS file (§1.1):
HEARME_DEPLOY_SHA="$(git rev-parse --short=12 HEAD)" \
  docker compose -f docker-compose.prod.yml up -d --build --remove-orphans
shred -u /tmp/cutover.dump
```

`--remove-orphans` retires the old `hearme-postgres` container. Keep its Docker
volume (`hearme-pgdata`) until you've confirmed RDS is serving correctly — it is
your rollback.

### 4.4 Restore drill (do this once before launch)

Managed backups you have never restored are untested backups. RDS restores to a
**new** instance (it never overwrites the source), which is exactly what you
want for a drill:

```sh
# Point-in-time restore to a throwaway instance:
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier hearme-prod \
  --target-db-instance-identifier hearme-restore-drill \
  --use-latest-restorable-time \
  --db-subnet-group-name hearme-db-subnets \
  --vpc-security-group-ids sg-0abc123 --no-publicly-accessible
aws rds wait db-instance-available --db-instance-identifier hearme-restore-drill
```

Then point a psql at the restored endpoint and confirm the schema + the 8 tables
are present and row counts look right (the managed-Postgres equivalent of
`scripts/verify-db.sh`, which itself targets the local container). Delete the
drill instance afterwards (`aws rds delete-db-instance --skip-final-snapshot`).

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
- [ ] Prod DB is on RDS (`scripts/provision-rds.sh`), with automated backups +
      PITR on, and the restore drill (§4.4) has been performed once.
- [ ] Broker `GET /healthz` and web `GET /api/healthz` are monitored.
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
