#!/usr/bin/env bash
# Apply the demo seed (db/init/03-seed.sql) to a running chorum postgres.
#
# Idempotent: the seed uses ON CONFLICT DO NOTHING / DO UPDATE so re-running
# is safe.
#
# Usage:
#   scripts/seed-demo.sh                    # uses the docker-compose admin role
#   DSN=postgres://... scripts/seed-demo.sh # custom DSN

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SEED="$HERE/../db/init/03-seed.sql"

DSN="${DSN:-postgres://chorum_admin:chorum_admin_dev@localhost:5432/chorum}"

if command -v psql >/dev/null 2>&1; then
  exec psql "$DSN" -v ON_ERROR_STOP=1 -f "$SEED"
fi

# Fall back to running psql inside the compose postgres container.
if docker compose ps -q postgres >/dev/null 2>&1; then
  exec docker compose exec -T postgres psql \
    "postgres://chorum_admin:chorum_admin_dev@localhost:5432/chorum" \
    -v ON_ERROR_STOP=1 < "$SEED"
fi

echo "Need either psql in PATH or the postgres compose service up. Aborting." >&2
exit 1
