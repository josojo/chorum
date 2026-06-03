#!/usr/bin/env bash
set -euo pipefail

# Container-DB role bootstrap, run by the postgres docker-entrypoint-initdb.d
# step (local dev, CI, and the container-Postgres staging box). The actual
# role/grant definition lives in db/init/roles.sql so the managed-Postgres
# path (scripts/bootstrap-rds.sh) applies the *same* boundary; this wrapper
# only supplies dev defaults and sets the admin role's own password, then hands
# off to that shared file.
#
# roles.sql is mounted at /hearme/roles.sql (see docker-compose.yml) — NOT in
# /docker-entrypoint-initdb.d, so the entrypoint does not also run it directly.

# Local dev defaults are intentionally low-value. Public staging/prod overlays
# must provide these through a gitignored .env / secret manager.
: "${HEARME_DB_WEB_PASSWORD:=hearme_web_dev}"
: "${HEARME_DB_BROKER_PASSWORD:=hearme_broker_dev}"
: "${HEARME_DB_CLASSIFIER_PASSWORD:=hearme_classifier_dev}"
: "${HEARME_DB_ADMIN_PASSWORD:=${POSTGRES_PASSWORD:-hearme_admin_dev}}"

ROLES_SQL="${HEARME_ROLES_SQL:-/hearme/roles.sql}"

# The admin role's password is set here (container DB), not in roles.sql — under
# managed Postgres the master password is set at instance creation instead.
psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  -v admin_user="$POSTGRES_USER" \
  -v admin_password="$HEARME_DB_ADMIN_PASSWORD" <<'SQL'
ALTER ROLE :"admin_user" WITH LOGIN PASSWORD :'admin_password';
SQL

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  -v web_password="$HEARME_DB_WEB_PASSWORD" \
  -v broker_password="$HEARME_DB_BROKER_PASSWORD" \
  -v classifier_password="$HEARME_DB_CLASSIFIER_PASSWORD" \
  -f "$ROLES_SQL"
