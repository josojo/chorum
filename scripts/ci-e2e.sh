#!/usr/bin/env bash
# End-to-end answer-pipeline check for CI (and local use).
#
# Brings a *fresh* chorum agent online against a running broker and has it answer
# one real question, then asserts the broker accepted the envelope and the
# aggregate moved. Everything is real except proof-of-personhood: onboarding uses
# the broker's phone-free dev bypass (POST /v1/dev/register, mounted only when
# CHORUM_BROKER_DEV_INSECURE_REGISTER=1). The agent's own Ed25519 key signs a
# real envelope that the broker verifies byte-for-byte — so a green run means the
# skill's sign -> submit -> verify -> aggregate path works against a live stack.
#
# Prereqs:
#   - a broker reachable at $BROKER_URL with the dev bypass enabled
#     (docker-compose.ci.yml), seeded with the demo questions (db/init/03-seed.sql)
#   - the chorum-skill binary at $CHORUM_BIN
#   - python3 with the `cryptography` package (for the one-time keypair)
#
# Env knobs (all optional):
#   BROKER_URL              default http://127.0.0.1:8000
#   CHORUM_BIN              default ./packages/skill/target/release/chorum-skill
#   CHORUM_SKILL_ROOT_DIR   default a fresh temp dir (the agent's home)
#   QUESTION_ID             default the seed's worldwide "AI agents" question
set -euo pipefail

BROKER_URL="${BROKER_URL:-http://127.0.0.1:8000}"
CHORUM_BIN="${CHORUM_BIN:-./packages/skill/target/release/chorum-skill}"
QUESTION_ID="${QUESTION_ID:-10000000-0000-0000-0000-000000000001}"

# A self-contained agent home so the run is reproducible and leaves no trace in
# the developer's ~/.hermes. Exported so the binary picks it up.
if [ -z "${CHORUM_SKILL_ROOT_DIR:-}" ]; then
  CHORUM_SKILL_ROOT_DIR="$(mktemp -d)/chorum-agent"
fi
export CHORUM_SKILL_ROOT_DIR
mkdir -p "$CHORUM_SKILL_ROOT_DIR"

if [ ! -x "$CHORUM_BIN" ]; then
  echo "FATAL: chorum-skill binary not found/executable at '$CHORUM_BIN'." >&2
  echo "       Build it first: (cd packages/skill && cargo build --release)" >&2
  exit 1
fi

echo "== chorum CI e2e =="
echo "  broker:      $BROKER_URL"
echo "  binary:      $CHORUM_BIN"
echo "  agent home:  $CHORUM_SKILL_ROOT_DIR"
echo "  question:    $QUESTION_ID"

# --- 1. Wait for the broker to be healthy --------------------------------------
echo "-- waiting for broker /healthz"
for i in $(seq 1 60); do
  if curl -fsS --max-time 3 "$BROKER_URL/healthz" >/dev/null 2>&1; then
    echo "   broker healthy after ${i}s"
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "FATAL: broker did not become healthy at $BROKER_URL" >&2
    exit 1
  fi
  sleep 1
done

# --- 2. Snapshot broker stats BEFORE onboarding + answering --------------------
# Taken before the dev registration and the envelope so both deltas are real:
# registering adds one agent, answering adds one answer.
read_stats() { curl -fsS --max-time 5 "$BROKER_URL/v1/stats"; }
stat_field() { python3 -c "import json,sys; print(json.load(sys.stdin)['$1'])"; }

BEFORE_JSON="$(read_stats)"
BEFORE_ANSWERS="$(printf '%s' "$BEFORE_JSON" | stat_field total_answers)"
BEFORE_AGENTS="$(printf '%s' "$BEFORE_JSON" | stat_field registered_agents)"
echo "-- stats before: total_answers=$BEFORE_ANSWERS registered_agents=$BEFORE_AGENTS"

# --- 3. Onboard via the phone-free dev bypass ----------------------------------
# Generate the agent's Ed25519 keypair, write the 32-byte seed where the binary
# expects it ($ROOT/agent_key), register the public key for a synthetic identity
# via /v1/dev/register, and capture the broker-signed DelegationToken. Doing the
# keygen here (not letting the binary's `onboard` create it) lets us register the
# exact public key that will later sign the envelope.
echo "-- generating agent key + dev-registering a synthetic identity"
TOKEN_FILE="$CHORUM_SKILL_ROOT_DIR/dev-delegation.json"
BROKER_URL="$BROKER_URL" \
AGENT_KEY_PATH="$CHORUM_SKILL_ROOT_DIR/agent_key" \
TOKEN_FILE="$TOKEN_FILE" \
python3 - <<'PY'
import base64, json, os, urllib.request, urllib.error
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import (
    Encoding, PrivateFormat, PublicFormat, NoEncryption,
)

broker = os.environ["BROKER_URL"].rstrip("/")
key_path = os.environ["AGENT_KEY_PATH"]
token_file = os.environ["TOKEN_FILE"]

# The binary stores the agent key as a raw 32-byte Ed25519 seed (see
# packages/skill/src/crypto.rs). Write the matching seed so the binary signs with
# the key we register here.
sk = Ed25519PrivateKey.generate()
seed = sk.private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption())
pub = sk.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
with open(key_path, "wb") as fh:
    fh.write(seed)
os.chmod(key_path, 0o600)
agent_key_b64 = base64.b64encode(pub).decode()

body = json.dumps({
    "agent_key": agent_key_b64,
    "nationality": "US",
    "satisfied_thresholds": [18],
}).encode()
req = urllib.request.Request(
    f"{broker}/v1/dev/register", data=body,
    headers={"content-type": "application/json"}, method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=30) as resp:
        ack = json.loads(resp.read().decode())
except urllib.error.HTTPError as exc:
    raise SystemExit(f"FATAL: /v1/dev/register HTTP {exc.code}: {exc.read()[:300]!r}")

if not ack.get("accepted"):
    raise SystemExit(f"FATAL: dev register rejected: {ack.get('reason')}")
token = ack.get("delegation_token")
if not token:
    raise SystemExit("FATAL: dev register accepted but returned no delegation_token")
with open(token_file, "w") as fh:
    json.dump(token, fh)
print(f"   registered agent_key={agent_key_b64[:12]}... token expires {token.get('expires_at')}")
PY

# Store the broker-signed token through the binary's own code path.
"$CHORUM_BIN" accept-mock-delegation "$TOKEN_FILE"

# A permissive policy so the gate deterministically permits the answer regardless
# of the question's topic (auto_answer is the master switch — topic_blocklist
# still wins, but we set none). See packages/skill/src/policy.rs.
cat > "$CHORUM_SKILL_ROOT_DIR/policy.yaml" <<'YAML'
auto_answer: true
max_answers_per_day: 100
YAML

# --- 4. The agent sees the question and answers it -----------------------------
echo "-- listing open questions the policy permits"
LIST_JSON="$("$CHORUM_BIN" list-questions --broker-url "$BROKER_URL")"
echo "   $LIST_JSON"
if ! printf '%s' "$LIST_JSON" | python3 -c "import json,sys; q=json.load(sys.stdin); ids=[x['question_id'] for x in q.get('questions',[])]; sys.exit(0 if '$QUESTION_ID' in ids else 1)"; then
  echo "FATAL: target question $QUESTION_ID is not in the answerable list." >&2
  echo "       (Is the demo seed applied and the question open + light-topic?)" >&2
  exit 1
fi

echo "-- submitting the answer through the binary (the same path the Hermes shim shells out to)"
SUBMIT_JSON="$("$CHORUM_BIN" submit-answer \
  --broker-url "$BROKER_URL" \
  --question-id "$QUESTION_ID" \
  --answer "Yes - CI exercised the chorum answer pipeline end to end.")"
echo "   $SUBMIT_JSON"
printf '%s' "$SUBMIT_JSON" | python3 -c "
import json, sys
r = json.load(sys.stdin)
if not r.get('accepted'):
    sys.exit('FATAL: broker did not accept the envelope: reason=%s' % r.get('reason'))
print('   broker accepted the envelope (reason=%s)' % r.get('reason'))
"

# --- 5. Assert the broker-side effects -----------------------------------------
AFTER_JSON="$(read_stats)"
AFTER_ANSWERS="$(printf '%s' "$AFTER_JSON" | stat_field total_answers)"
AFTER_AGENTS="$(printf '%s' "$AFTER_JSON" | stat_field registered_agents)"
echo "-- stats after:  total_answers=$AFTER_ANSWERS registered_agents=$AFTER_AGENTS"

fail=0
if [ "$AFTER_ANSWERS" -ne "$((BEFORE_ANSWERS + 1))" ]; then
  echo "FATAL: total_answers did not increase by exactly 1 ($BEFORE_ANSWERS -> $AFTER_ANSWERS)." >&2
  fail=1
fi
if [ "$AFTER_AGENTS" -ne "$((BEFORE_AGENTS + 1))" ]; then
  echo "FATAL: registered_agents did not increase by exactly 1 ($BEFORE_AGENTS -> $AFTER_AGENTS)." >&2
  fail=1
fi

# --- 6. Assert the agent's local ledger recorded the accepted answer -----------
echo "-- confirming the local ledger recorded the submission"
REVIEW_JSON="$("$CHORUM_BIN" review-answers)"
printf '%s' "$REVIEW_JSON" | python3 -c "
import json, sys
r = json.load(sys.stdin)
hit = [a for a in r.get('answers', []) if a.get('question_id') == '$QUESTION_ID']
if not hit:
    sys.exit('FATAL: the submission is not in the local ledger.')
if not hit[0].get('accepted'):
    sys.exit('FATAL: the ledger marked the submission as not accepted.')
print('   ledger shows the accepted answer for the question.')
"

if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "== e2e PASS: a fresh agent onboarded and answered a question on the live stack =="
