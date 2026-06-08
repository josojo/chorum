#!/usr/bin/env bash
#
# One-time bootstrap of a freshly provisioned RDS instance (scripts/provision-rds.sh)
# so the prod stack can point at it. See docs/DEPLOYMENT.md §4.
#
# Does the three things the postgres docker-entrypoint used to do on a fresh
# on-box volume, but against managed Postgres where no entrypoint runs:
#   1. CREATE EXTENSION pgcrypto         (questions.nonce default needs it;
#                                         must exist BEFORE the schema is applied)
#   2. apply the schema                  (runs the compose `migrator` once;
#                                         migrate.mjs bootstraps an empty DB,
#                                         applying 0000_init + every later delta)
#   3. apply roles + grants              (db/init/roles.sql — the SAME boundary
#                                         CI checks via scripts/verify-db.sh)
#
# Idempotent: safe to re-run (extension IF NOT EXISTS, migrator skips applied
# versions, roles are CREATE-IF-NOT-EXISTS + re-asserted GRANTs).
#
# Runs on the prod box (needs docker + this repo checkout + the rendered .env).
# Uses the postgres:16 image for psql and the compose migrator for the schema,
# so the host needs neither psql nor node. Containers use --network host so they
# reach RDS from the host's ENI (the source the DB security group allows).
#
# Usage:
#   scripts/bootstrap-rds.sh [path-to-.env]      # default: ~/chorum/.env
set -euo pipefail

die() { echo "ERROR: $*" >&2; exit 1; }

ENV_FILE="${1:-$HOME/chorum/.env}"
[ -f "$ENV_FILE" ] || die "no env file at ${ENV_FILE} — render it from SSM first (scripts/render-secrets-env.sh prod)"

# Load the rendered prod env (CHORUM_PROD_POSTGRES_HOST + the role passwords).
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

: "${CHORUM_PROD_POSTGRES_HOST:?missing in ${ENV_FILE}}"
: "${CHORUM_PROD_POSTGRES_ADMIN_PASSWORD:?missing in ${ENV_FILE}}"
: "${CHORUM_PROD_POSTGRES_WEB_PASSWORD:?missing in ${ENV_FILE}}"
: "${CHORUM_PROD_POSTGRES_BROKER_PASSWORD:?missing in ${ENV_FILE}}"
: "${CHORUM_PROD_POSTGRES_CLASSIFIER_PASSWORD:?missing in ${ENV_FILE}}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_IMAGE="postgres:16"
PGHOST="$CHORUM_PROD_POSTGRES_HOST"

# psql in a throwaway container, connecting to RDS over TLS as the master role.
psql_admin() {
  docker run --rm --network host \
    -e PGPASSWORD="$CHORUM_PROD_POSTGRES_ADMIN_PASSWORD" \
    -e PGSSLMODE=require \
    -v "$REPO_ROOT/db/init:/init:ro" \
    "$PG_IMAGE" \
    psql -v ON_ERROR_STOP=1 \
      -h "$PGHOST" -U chorum_admin -d chorum "$@"
}

echo "[bootstrap-rds] 1/4 ensuring pgcrypto extension on ${PGHOST}"
psql_admin -c 'CREATE EXTENSION IF NOT EXISTS "pgcrypto";'

echo "[bootstrap-rds] 2/4 applying schema via the migrator (admin DSN → RDS)"
docker compose --env-file "$ENV_FILE" -f "$REPO_ROOT/docker-compose.prod.yml" \
  run --rm migrator

echo "[bootstrap-rds] 3/4 applying roles + grants (db/init/roles.sql)"
psql_admin \
  -v web_password="$CHORUM_PROD_POSTGRES_WEB_PASSWORD" \
  -v broker_password="$CHORUM_PROD_POSTGRES_BROKER_PASSWORD" \
  -v classifier_password="$CHORUM_PROD_POSTGRES_CLASSIFIER_PASSWORD" \
  -f /init/roles.sql

# ADR-098: the per-question voter-tag secrets live in a broker-OWNED database,
# co-located on this same RDS instance (the broker has only USAGE on the shared
# schema, so it can't create the table in `chorum`). Owned by chorum_broker, so
# the broker's CREATE TABLE IF NOT EXISTS (secretsDb.ts) succeeds at startup.
echo "[bootstrap-rds] 4/4 ensuring broker-owned chorum_secrets database (ADR-098)"
if [ "$(psql_admin -tAc "SELECT 1 FROM pg_database WHERE datname='chorum_secrets'")" != "1" ]; then
  psql_admin -c 'CREATE DATABASE chorum_secrets OWNER chorum_broker;'
  echo "[bootstrap-rds]   created chorum_secrets"
else
  echo "[bootstrap-rds]   chorum_secrets already present — skipping"
fi

cat <<'EOF'
[bootstrap-rds] done. RDS now has: pgcrypto, the full schema, the three
scoped roles (chorum_web / chorum_broker / chorum_classifier), and the
broker-owned chorum_secrets database (ADR-098).

Verify the grant boundary held (optional but recommended) by spot-checking that
chorum_web cannot read envelopes:
  psql "postgres://chorum_web:<web-pw>@<host>:5432/chorum?sslmode=require" \
    -c 'SELECT count(*) FROM envelopes;'        # expect: permission denied

Then bring the stack up:
  docker compose -f docker-compose.prod.yml up -d --build --remove-orphans
EOF
