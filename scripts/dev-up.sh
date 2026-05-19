#!/usr/bin/env bash
# Brings up the shared Postgres for hearme-web + hearme-broker.
# Idempotent: re-running just ensures the container is healthy.
#
# To wipe the database and re-apply migrations from scratch:
#   docker compose down -v && scripts/dev-up.sh
set -euo pipefail

cd "$(dirname "$0")/.."

docker compose up -d postgres

echo "Waiting for postgres to become healthy..."
until [ "$(docker inspect -f '{{.State.Health.Status}}' hearme-postgres 2>/dev/null || echo starting)" = "healthy" ]; do
  sleep 1
done

echo "Postgres is up."
echo "  hearme_web    -> postgres://hearme_web:hearme_web_dev@localhost:5432/hearme"
echo "  hearme_broker -> postgres://hearme_broker:hearme_broker_dev@localhost:5432/hearme"
