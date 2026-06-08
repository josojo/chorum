#!/usr/bin/env bash
# One-command rollback — run ON THE BOX (staging or prod), from anywhere.
#
#   scripts/rollback.sh            # roll back to PREVIOUS_GOOD_SHA (.deploy-state)
#   scripts/rollback.sh <git-sha>  # roll back to a specific commit
#   scripts/rollback.sh -y         # skip the confirmation prompt
#
# How it works: checks out the target SHA, then `docker compose up -d` pinned to
# that SHA's images via CHORUM_DEPLOY_SHA. If the previous build's images are
# still on the box (deploy-finalize keeps the last two), the bring-up does NOT
# rebuild — recovery is seconds, and does not depend on the target source even
# building. If they were pruned, it falls back to --build. A health gate then
# confirms the rolled-back stack answers before declaring success.
#
# IMPORTANT — this rolls back CODE/IMAGES, not the DATABASE. Drizzle migrations
# are forward-only (packages/web/scripts/migrate.mjs only ever rolls forward).
# If the bad deploy included a schema migration, see docs/DEPLOYMENT.md §7: an
# additive migration is usually safe to roll back under (old code ignores new
# columns); a destructive one needs a restore from backup (§4), not this script.
#
# Self-contained on purpose: it reads its whole body into memory (the `{ … }`
# wrapper) before touching git, so `git reset --hard` rewriting this file mid-run
# is safe, and it inlines the health poll + state update rather than calling
# sibling scripts that may not exist at the target SHA.

{  # ---- brace wrapper: force bash to buffer the entire script before executing ----
set -euo pipefail

# Resolve repo root from this script's location BEFORE any checkout moves it.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

assume_yes=0
target=""
for arg in "$@"; do
  case "$arg" in
    -y | --yes) assume_yes=1 ;;
    -*) echo "unknown flag: $arg" >&2; exit 2 ;;
    *) target="$arg" ;;
  esac
done

state_file="${DEPLOY_STATE_FILE:-.deploy-state}"
# Always succeeds (prints nothing if the file or key is absent) so a missing
# .deploy-state doesn't trip `set -e` when the operator passes an explicit SHA.
read_state() {
  [ -f "$state_file" ] || return 0
  sed -n "s/^$1=//p" "$state_file" | head -n1
}

env_name="${CHORUM_ROLLBACK_ENV:-$(read_state ENV)}"
env_name="${env_name:-staging}"
last_good="$(read_state LAST_GOOD_SHA)"
prev_good="$(read_state PREVIOUS_GOOD_SHA)"

if [ -z "$target" ]; then
  target="$prev_good"
  if [ -z "$target" ]; then
    echo "no target SHA given and PREVIOUS_GOOD_SHA is empty in $state_file" >&2
    echo "pass an explicit commit:  scripts/rollback.sh <git-sha>" >&2
    exit 2
  fi
fi

# Compose overlay for this environment (override with CHORUM_COMPOSE_FILES).
if [ -n "${CHORUM_COMPOSE_FILES:-}" ]; then
  read -r -a compose_files <<< "$CHORUM_COMPOSE_FILES"
else
  case "$env_name" in
    staging) compose_files=(-f docker-compose.yml -f docker-compose.staging.yml) ;;
    # prod is a standalone file (it `extends` the base internally), so a single
    # -f — not the base+overlay pair staging uses. It defines no postgres
    # service: prod's DB is RDS. See docs/DEPLOYMENT.md §4.
    prod)    compose_files=(-f docker-compose.prod.yml) ;;
    *) echo "unknown ENV '$env_name'; set CHORUM_COMPOSE_FILES explicitly" >&2; exit 2 ;;
  esac
fi

echo "[rollback] env=$env_name  currently-good=${last_good:-<unknown>}  ->  target=$target"
echo "[rollback] compose: docker compose ${compose_files[*]}"
if [ "$assume_yes" -ne 1 ] && [ -t 0 ]; then
  printf '[rollback] proceed? [y/N] '
  read -r reply
  case "$reply" in y | Y | yes | YES) ;; *) echo "aborted"; exit 1 ;; esac
fi

# Make the target reachable, then pin the working tree to it. `reset --hard`
# mirrors how deploy-staging.yml moves the box, and keeps .env / .deploy-state
# (both gitignored) untouched.
git fetch --quiet origin
git reset --hard "$target"
short_sha="$(git rev-parse --short=12 HEAD)"
echo "[rollback] now at $short_sha: $(git log -1 --pretty=%s)"

test -f .env || { echo "missing .env on the box; cannot bring the stack up" >&2; exit 1; }
set -a; . ./.env; set +a
export CHORUM_DEPLOY_SHA="$short_sha"

# Prefer the already-built image for this SHA (fast, and independent of whether
# the target source still builds). Fall back to a rebuild if it was pruned.
if ! docker compose "${compose_files[@]}" up -d --remove-orphans --no-build; then
  echo "[rollback] no prebuilt image for $short_sha (or up failed) — rebuilding from source"
  docker compose "${compose_files[@]}" up -d --remove-orphans --build
fi

# Inline health gate (sibling scripts may not exist at the target SHA).
echo "[rollback] waiting for the stack to come healthy…"
ok=1
for ((i = 1; i <= 60; i++)); do
  bcode="$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:8000/healthz 2>/dev/null || true)"
  # Tolerate older web builds without /api/healthz: treat any <500 on / as up.
  wcode="$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:3000/ 2>/dev/null || true)"
  if [ "$bcode" = "200" ] && [ -n "$wcode" ] && [ "$wcode" -lt 500 ] 2>/dev/null; then
    ok=0; echo "[rollback] healthy after ${i} attempt(s) (broker=$bcode web=$wcode)"; break
  fi
  sleep 2
done
if [ "$ok" -ne 0 ]; then
  echo "[rollback] FAILED: stack not healthy after rollback (broker=${bcode:-none} web=${wcode:-none})" >&2
  echo "[rollback] containers:" >&2
  docker ps --format 'table {{.Names}}\t{{.Status}}' | grep -E 'chorum-|NAMES' >&2 || true
  exit 1
fi

# Record the rolled-to SHA as the running-good one. Keep PREVIOUS_GOOD_SHA as it
# was, so a second `rollback.sh` with no arg steps further back rather than
# bouncing to the SHA we just rejected.
tmp="$state_file.tmp"
{
  echo "LAST_GOOD_SHA=$short_sha"
  echo "PREVIOUS_GOOD_SHA=$prev_good"
  echo "ENV=$env_name"
  echo "DEPLOYED_AT=$(date -uIs)"
} > "$tmp"
mv "$tmp" "$state_file"

echo "[rollback] done — $env_name is serving $short_sha"
exit 0
}  # ---- end brace wrapper ----
