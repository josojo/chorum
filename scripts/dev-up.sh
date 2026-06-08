#!/usr/bin/env bash
# Brings up the shared Postgres for chorum-web + chorum-broker.
# Idempotent: re-running just ensures the container is healthy.
#
# To wipe the database and re-apply migrations from scratch:
#   docker compose down -v && scripts/dev-up.sh
set -euo pipefail

cd "$(dirname "$0")/.."

docker compose up -d postgres

echo "Waiting for postgres to become healthy..."
until [ "$(docker inspect -f '{{.State.Health.Status}}' chorum-postgres 2>/dev/null || echo starting)" = "healthy" ]; do
  sleep 1
done

echo "Postgres is up."
echo "  chorum_web    -> postgres://chorum_web:chorum_web_dev@localhost:5432/chorum"
echo "  chorum_broker -> postgres://chorum_broker:chorum_broker_dev@localhost:5432/chorum"
