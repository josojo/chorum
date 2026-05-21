#!/bin/sh
# Skill container bootstrap. Idempotent.
#
# 1. Ensures the root dir exists.
# 2. Generates the agent key if missing (load_or_create_agent_keypair).
# 3. If no DelegationToken is on disk: replay a captured proof fixture
#    ($HEARME_SKILL_DEV_FIXTURE) through the broker's /v1/register via
#    scripts/mock-onboard.py when provided, otherwise print onboarding
#    instructions (a real scan is required — there is no way to fake valid
#    Self proofs).
# 4. Writes a permissive dev policy.yaml if none is mounted.
# 5. Execs the dev runner, which provides a stub host (FakeLLM, auto-approve
#    channel, Mem0 stub memory) and starts the broker-polling loop. The loop
#    tolerates a missing delegation (logs + idles) until onboarding completes.
#
# All of this is dev-only. Real Hermes integration replaces this entrypoint
# with the Hermes runtime, which provides the host instead.
set -eu

ROOT="${HEARME_SKILL_ROOT_DIR:-/data}"
mkdir -p "$ROOT"

# --- Step 2: load-or-create agent key. ------------------------------------
# Reuse the skill's keystore so we get the exact same on-disk format.
AGENT_PUB_B64="$(python - <<'PY'
import base64, os
from pathlib import Path
from hearme_skill.crypto.keystore import load_or_create_agent_keypair
path = Path(os.environ.get("HEARME_SKILL_ROOT_DIR", "/data")) / "agent_key"
kp = load_or_create_agent_keypair(path)
print(base64.b64encode(kp.public_bytes).decode("ascii"))
PY
)"
echo "[hearme-skill] agent pubkey = $AGENT_PUB_B64"

# --- Step 3: obtain a DelegationToken if not present. ---------------------
# A valid token requires real Self proofs verified once at the broker. Either
# replay a captured fixture (HEARME_SKILL_DEV_FIXTURE) through /v1/register, or
# onboard interactively by scanning the QR codes from the bridge.
if [ ! -f "$ROOT/delegation.token" ]; then
  if [ -n "${HEARME_SKILL_DEV_FIXTURE:-}" ] && [ -f "${HEARME_SKILL_DEV_FIXTURE}" ]; then
    echo "[hearme-skill] registering dev fixture ${HEARME_SKILL_DEV_FIXTURE} via mock-onboard..."
    python /usr/local/bin/mock-onboard.py \
      --from-bridge "${HEARME_SKILL_DEV_FIXTURE}" \
      --broker-url "${HEARME_SKILL_BROKER_URL:-http://broker:8000}" \
      > "$ROOT/delegation.token.tmp"
    mv "$ROOT/delegation.token.tmp" "$ROOT/delegation.token"
    chmod 600 "$ROOT/delegation.token"
  else
    echo "[hearme-skill] no delegation token and no HEARME_SKILL_DEV_FIXTURE."
    echo "[hearme-skill] Onboard by scanning a Self (mock) passport:"
    echo "[hearme-skill]   docker compose exec skill hearme-skill onboard \\"
    echo "[hearme-skill]     --bridge-url ${HEARME_SKILL_SELF_BRIDGE_URL:-http://self-bridge:8787} \\"
    echo "[hearme-skill]     --broker-url ${HEARME_SKILL_BROKER_URL:-http://broker:8000}"
    echo "[hearme-skill] The loop will idle (no answers) until a token exists."
  fi
fi

# --- Step 4: default dev policy. ------------------------------------------
if [ ! -f "$ROOT/policy.yaml" ]; then
  cat > "$ROOT/policy.yaml" <<EOF
# Dev policy. The skill container auto-approves answers so the e2e flow
# runs without a human in the loop. Production users author this file by
# hand (ARCHITECTURE.md §7.2).
auto_answer: true
auto_submit_window_seconds: 5
max_answers_per_day: 50
EOF
fi

# --- Step 5: hand off to the dev runner. ----------------------------------
exec python -m hearme_skill.dev_runner
