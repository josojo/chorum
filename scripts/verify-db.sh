#!/usr/bin/env bash
# Verifies the shared postgres came up correctly:
#   - all five tables present (ARCHITECTURE_V0.md §3)
#   - both writer roles created (§4)
#   - grant boundaries enforced (web cannot read/write envelopes, broker cannot write questions)
#   - composite PK on envelopes rejects duplicate (question_id, unique_identifier) — §3 Sybil claim
#
# Assumes the postgres container from docker-compose is running and healthy.
# Used by .github/workflows/db.yml and by hand locally.
set -euo pipefail

CONTAINER=${CONTAINER:-chorum-postgres}

admin()      { docker exec "$CONTAINER" psql -U chorum_admin -d chorum -tAc "$1"; }
web()        { docker exec -e PGPASSWORD=chorum_web_dev        "$CONTAINER" psql -h localhost -U chorum_web        -d chorum -tAc "$1"; }
broker()     { docker exec -e PGPASSWORD=chorum_broker_dev     "$CONTAINER" psql -h localhost -U chorum_broker     -d chorum -tAc "$1"; }
classifier() { docker exec -e PGPASSWORD=chorum_classifier_dev "$CONTAINER" psql -h localhost -U chorum_classifier -d chorum -tAc "$1"; }

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

# 1. Schema applied. (Includes the Self revocation-listener tables
#    self_chain_cursors + self_nullifier_invalidations — ARCHITECTURE_V0.md §5.)
expected="aggregates askers envelopes questions registrations revocations self_chain_cursors self_nullifier_invalidations"
actual=$(admin "SELECT string_agg(tablename, ' ' ORDER BY tablename) FROM pg_tables WHERE schemaname='public';")
[ "$actual" = "$expected" ] || fail "tables mismatch: got '$actual', want '$expected'"
pass "schema applied — 8 tables"

# 2. Writer roles exist.
for role in chorum_web chorum_broker chorum_classifier; do
  [ "$(admin "SELECT 1 FROM pg_roles WHERE rolname='$role';")" = "1" ] || fail "role $role missing"
done
pass "writer roles created"

# 3. chorum_web blocked from envelopes (boundary check).
if web "INSERT INTO envelopes(question_id, unique_identifier, answer, disclosed_predicates, agent_signature, delegation_hash) VALUES (gen_random_uuid(),'x','y','{}','z','w');" 2>/dev/null; then
  fail "chorum_web should be denied INSERT on envelopes"
fi
pass "chorum_web denied INSERT envelopes"

# 3b. chorum_web blocked from raw envelopes reads (public pages use aggregates).
if web "SELECT COUNT(*) FROM envelopes;" 2>/dev/null; then
  fail "chorum_web should be denied SELECT on envelopes"
fi
pass "chorum_web denied SELECT envelopes"

# 4. chorum_broker blocked from questions (boundary check).
if broker "INSERT INTO questions(text, closes_at) VALUES ('x', now());" 2>/dev/null; then
  fail "chorum_broker should be denied INSERT on questions"
fi
pass "chorum_broker denied INSERT questions"

# 4b. chorum_classifier boundaries — can SELECT and update topic, but
#     nothing else. A compromise of these credentials must NOT enable reading
#     envelopes / registrations or editing any other question column.
web "INSERT INTO questions(text, closes_at) VALUES ('classifier-bound', now() + interval '1 hour');" > /dev/null
classifier_qid=$(web "SELECT id FROM questions WHERE text='classifier-bound' ORDER BY created_at DESC LIMIT 1;")
[ -n "$classifier_qid" ] || fail "could not seed question for classifier boundary check"

# 4b.i — can SELECT.
[ "$(classifier "SELECT count(*) FROM questions WHERE id='$classifier_qid';")" = "1" ] \
  || fail "chorum_classifier should be able to SELECT questions"
# 4b.ii — can UPDATE topic.
classifier "UPDATE questions SET topic='ai' WHERE id='$classifier_qid';" > /dev/null
[ "$(admin "SELECT topic FROM questions WHERE id='$classifier_qid';")" = "ai" ] \
  || fail "chorum_classifier UPDATE topic did not stick"
# 4b.iii — CANNOT update any other column.
if classifier "UPDATE questions SET text='hijacked' WHERE id='$classifier_qid';" 2>/dev/null; then
  fail "chorum_classifier should be denied UPDATE on questions.text"
fi
# 4b.iv — CANNOT insert.
if classifier "INSERT INTO questions(text, closes_at) VALUES ('x', now() + interval '1 hour');" 2>/dev/null; then
  fail "chorum_classifier should be denied INSERT on questions"
fi
# 4b.v — CANNOT read envelopes / registrations.
if classifier "SELECT 1 FROM envelopes LIMIT 1;" 2>/dev/null; then
  fail "chorum_classifier should be denied SELECT on envelopes"
fi
if classifier "SELECT 1 FROM registrations LIMIT 1;" 2>/dev/null; then
  fail "chorum_classifier should be denied SELECT on registrations"
fi
admin "DELETE FROM questions WHERE id='$classifier_qid';" > /dev/null
pass "chorum_classifier scoped to SELECT + UPDATE(topic) only"

# 5. Composite PK rejects duplicate Sybil writes.
web "INSERT INTO questions(text, closes_at) VALUES ('ci-test?', now() + interval '1 hour');" > /dev/null
qid=$(web "SELECT id FROM questions WHERE text='ci-test?' ORDER BY created_at DESC LIMIT 1;")
[ -n "$qid" ] || fail "could not create test question"

broker "INSERT INTO envelopes(question_id, unique_identifier, answer, disclosed_predicates, agent_signature, delegation_hash) VALUES ('$qid', 'uid-ci', 'a', '{}', 's', 'd');" > /dev/null

if broker "INSERT INTO envelopes(question_id, unique_identifier, answer, disclosed_predicates, agent_signature, delegation_hash) VALUES ('$qid', 'uid-ci', 'b', '{}', 's2', 'd2');" 2>/dev/null; then
  fail "duplicate envelope should have been rejected by PK"
fi
pass "composite PK rejects duplicate envelopes"

admin "TRUNCATE envelopes, aggregates, revocations, registrations, questions, askers RESTART IDENTITY CASCADE;" > /dev/null

echo
echo "All DB checks passed."
