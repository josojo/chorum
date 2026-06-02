#!/usr/bin/env bash
# Deploy health gate — block until the freshly-(re)started stack answers, or
# fail loudly so the caller can abort/roll back.
#
# Polls the loopback-published health endpoints the box already exposes
# (docker-compose.yml binds 127.0.0.1:8000 broker / 127.0.0.1:3000 web):
#   broker  GET /healthz        -> {"status":"ok"}
#   web     GET /api/healthz    -> {"status":"ok"}
#
# Why a poll instead of `docker compose up --wait`: --wait's handling of the
# one-shot `migrator` (exits 0) is version-dependent and has historically
# errored on a clean success. Polling the real HTTP surface is the thing we
# actually care about and is compose-version-independent.
#
# Optional env:
#   BROKER_HEALTH_URL   default http://127.0.0.1:8000/healthz
#   WEB_HEALTH_URL      default http://127.0.0.1:3000/api/healthz
#   HEALTHGATE_RETRIES  attempts per endpoint (default 60)
#   HEALTHGATE_DELAY    seconds between attempts (default 2)
#
# Exit 0 once every endpoint returns 200; non-zero (and a diagnostic) if any
# endpoint never comes healthy within retries*delay seconds.
set -euo pipefail

BROKER_HEALTH_URL="${BROKER_HEALTH_URL:-http://127.0.0.1:8000/healthz}"
WEB_HEALTH_URL="${WEB_HEALTH_URL:-http://127.0.0.1:3000/api/healthz}"
retries="${HEALTHGATE_RETRIES:-60}"
delay="${HEALTHGATE_DELAY:-2}"

wait_for() {
  local name="$1" url="$2" i code
  for ((i = 1; i <= retries; i++)); do
    code="$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 5 "$url" 2>/dev/null || true)"
    if [ "$code" = "200" ]; then
      echo "[healthgate] $name healthy ($url) after ${i} attempt(s)"
      return 0
    fi
    sleep "$delay"
  done
  echo "[healthgate] $name NOT healthy after $((retries * delay))s ($url, last code=${code:-none})" >&2
  return 1
}

rc=0
wait_for broker "$BROKER_HEALTH_URL" || rc=1
wait_for web "$WEB_HEALTH_URL" || rc=1
exit "$rc"
