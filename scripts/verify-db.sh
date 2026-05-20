#!/usr/bin/env bash
# Verifies the shared postgres came up correctly:
#   - all five tables present (ARCHITECTURE.md §3)
#   - both writer roles created (§4)
#   - grant boundaries enforced (web cannot read/write envelopes, broker cannot write questions)
#   - composite PK on envelopes rejects duplicate (question_id, unique_identifier) — §3 Sybil claim
#
# Assumes the postgres container from docker-compose is running and healthy.
# Used by .github/workflows/db.yml and by hand locally.
set -euo pipefail

CONTAINER=${CONTAINER:-hearme-postgres}

admin()  { docker exec "$CONTAINER" psql -U hearme_admin -d hearme -tAc "$1"; }
web()    { docker exec -e PGPASSWORD=hearme_web_dev    "$CONTAINER" psql -h localhost -U hearme_web    -d hearme -tAc "$1"; }
broker() { docker exec -e PGPASSWORD=hearme_broker_dev "$CONTAINER" psql -h localhost -U hearme_broker -d hearme -tAc "$1"; }

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

# 1. Schema applied.
expected="aggregates askers envelopes nullifiers questions revocations"
actual=$(admin "SELECT string_agg(tablename, ' ' ORDER BY tablename) FROM pg_tables WHERE schemaname='public';")
[ "$actual" = "$expected" ] || fail "tables mismatch: got '$actual', want '$expected'"
pass "schema applied — 6 tables"

# 2. Writer roles exist.
for role in hearme_web hearme_broker; do
  [ "$(admin "SELECT 1 FROM pg_roles WHERE rolname='$role';")" = "1" ] || fail "role $role missing"
done
pass "writer roles created"

# 3. hearme_web blocked from envelopes (boundary check).
if web "INSERT INTO envelopes(question_id, unique_identifier, answer, disclosed_predicates, agent_signature, delegation_hash) VALUES (gen_random_uuid(),'x','y','{}','z','w');" 2>/dev/null; then
  fail "hearme_web should be denied INSERT on envelopes"
fi
pass "hearme_web denied INSERT envelopes"

# 3b. hearme_web blocked from raw envelopes reads (public pages use aggregates).
if web "SELECT COUNT(*) FROM envelopes;" 2>/dev/null; then
  fail "hearme_web should be denied SELECT on envelopes"
fi
pass "hearme_web denied SELECT envelopes"

# 4. hearme_broker blocked from questions (boundary check).
if broker "INSERT INTO questions(text, closes_at) VALUES ('x', now());" 2>/dev/null; then
  fail "hearme_broker should be denied INSERT on questions"
fi
pass "hearme_broker denied INSERT questions"

# 5. Composite PK rejects duplicate Sybil writes.
web "INSERT INTO questions(text, closes_at) VALUES ('ci-test?', now() + interval '1 hour');" > /dev/null
qid=$(web "SELECT id FROM questions WHERE text='ci-test?' ORDER BY created_at DESC LIMIT 1;")
[ -n "$qid" ] || fail "could not create test question"

broker "INSERT INTO envelopes(question_id, unique_identifier, answer, disclosed_predicates, agent_signature, delegation_hash) VALUES ('$qid', 'uid-ci', 'a', '{}', 's', 'd');" > /dev/null

if broker "INSERT INTO envelopes(question_id, unique_identifier, answer, disclosed_predicates, agent_signature, delegation_hash) VALUES ('$qid', 'uid-ci', 'b', '{}', 's2', 'd2');" 2>/dev/null; then
  fail "duplicate envelope should have been rejected by PK"
fi
pass "composite PK rejects duplicate envelopes"

admin "TRUNCATE envelopes, aggregates, revocations, nullifiers, questions, askers RESTART IDENTITY CASCADE;" > /dev/null

echo
echo "All DB checks passed."
