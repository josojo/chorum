#!/usr/bin/env bash
# Record the last-known-good deploy and prune stale images — run ON THE BOX,
# from the repo root (~/chorum), AFTER the health gate (scripts/healthgate.sh)
# has passed. If the deploy is unhealthy, do NOT call this: the previous
# .deploy-state stays authoritative so `scripts/rollback.sh` still knows the
# good SHA to return to.
#
# Writes ./.deploy-state (gitignored, sits next to .env), the source of truth
# for rollback:
#   LAST_GOOD_SHA=<git short sha now running and verified healthy>
#   PREVIOUS_GOOD_SHA=<the SHA this one replaced — rollback's default target>
#   ENV=<staging|prod>
#   DEPLOYED_AT=<UTC ISO8601>
#
# Then prunes chorum-* images, KEEPING the current + previous good SHAs (so
# rollback can re-`up` the previous build without rebuilding) plus the local
# `dev` tag. Without this, every deploy leaves another SHA-tagged image behind
# and the disk fills.
#
# Usage:  scripts/deploy-finalize.sh <staging|prod>
set -euo pipefail

env_name="${1:-}"
case "$env_name" in
  staging | prod) ;;
  *) echo "usage: $0 <staging|prod>" >&2; exit 2 ;;
esac

state_file="${DEPLOY_STATE_FILE:-.deploy-state}"
new_sha="$(git rev-parse --short=12 HEAD)"

# The SHA we're replacing becomes the rollback target. Re-deploying the same
# SHA (e.g. a re-run) must not clobber a genuinely-different previous good.
prev_good=""
if [ -f "$state_file" ]; then
  old_last="$(sed -n 's/^LAST_GOOD_SHA=//p' "$state_file" | head -n1)"
  old_prev="$(sed -n 's/^PREVIOUS_GOOD_SHA=//p' "$state_file" | head -n1)"
  if [ -n "$old_last" ] && [ "$old_last" != "$new_sha" ]; then
    prev_good="$old_last"
  else
    prev_good="$old_prev"
  fi
fi

tmp="$state_file.tmp"
{
  echo "LAST_GOOD_SHA=$new_sha"
  echo "PREVIOUS_GOOD_SHA=$prev_good"
  echo "ENV=$env_name"
  echo "DEPLOYED_AT=$(date -uIs)"
} > "$tmp"
mv "$tmp" "$state_file"
echo "[deploy-finalize] recorded LAST_GOOD_SHA=$new_sha PREVIOUS_GOOD_SHA=${prev_good:-<none>} ($env_name)"

# Prune older chorum-* image tags, keeping what rollback needs.
keep=" $new_sha $prev_good dev "
pruned=0
while read -r repo tag; do
  case "$keep" in *" $tag "*) continue ;; esac
  if docker rmi "$repo:$tag" >/dev/null 2>&1; then
    pruned=$((pruned + 1))
  fi
done < <(docker images --format '{{.Repository}} {{.Tag}}' | awk '$1 ~ /^chorum-/ && $2 != "<none>"')
echo "[deploy-finalize] pruned $pruned stale chorum-* image tag(s); kept ${new_sha}, ${prev_good:-<none>}, dev"
