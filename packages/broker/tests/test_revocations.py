"""Per-envelope override (§1.12 "override is sacred").

Covers the two halves of the revocation route:

  1. The cryptographic core — ``revocation_signing_input`` is byte-stable, the
     verifier rejects swapped fields and bad sigs, and a captured *envelope*
     signature CANNOT be replayed as a revocation (the ``REVOKE`` domain
     separator does its job).

  2. The destructive DB step — ``delete_one_envelope_and_recompute`` deletes
     exactly one envelope, rebuilds that question's aggregate from the
     remaining envelopes, drops the aggregate row when the last envelope goes,
     and is idempotent for a non-existent (question_id, unique_identifier).
"""

from __future__ import annotations

import base64
import json
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from hearme_broker.db import queries as q
from hearme_broker.models.schemas import RejectionReason
from hearme_broker.verify.canonical import delegation_hash
from hearme_broker.verify.envelope import (
    VerifyEnvelopeError,
    envelope_signing_input,
    revocation_signing_input,
    verify_revocation_signature,
)


# ----- pure: revocation_signing_input ------------------------------------


def test_revocation_signing_input_is_deterministic():
    qid = uuid.UUID("00000000-0000-0000-0000-0000000000aa")
    dhash = "deadbeef" * 8
    assert revocation_signing_input(qid, dhash) == revocation_signing_input(
        str(qid), dhash
    )


def test_revocation_signing_input_differs_from_envelope_signing_input():
    """The whole point of the ``REVOKE`` domain separator: a captured envelope
    signature must NOT verify as a revocation, and vice versa. If the two
    digests are ever equal a signature crosses the boundary."""
    qid = uuid.uuid4()
    dhash = "ab" * 32
    assert revocation_signing_input(qid, dhash) != envelope_signing_input(
        qid, answer="yes", nonce="any", delegation_hash_hex=dhash
    )


# ----- pure: verify_revocation_signature ---------------------------------


def _sign_revocation(agent_signing_key, qid, dhash):
    sig = agent_signing_key.sign(revocation_signing_input(qid, dhash)).signature
    return base64.b64encode(sig).decode("ascii")


def test_verify_revocation_signature_happy(agent_signing_key, agent_key_b64):
    qid = uuid.uuid4()
    dhash = "01" * 32
    sig = _sign_revocation(agent_signing_key, qid, dhash)
    verify_revocation_signature(
        agent_pubkey_base64=agent_key_b64,
        question_id=qid,
        delegation_hash_hex=dhash,
        revocation_signature_base64=sig,
    )


def test_verify_revocation_rejects_swapped_question(agent_signing_key, agent_key_b64):
    sig = _sign_revocation(agent_signing_key, uuid.uuid4(), "02" * 32)
    with pytest.raises(VerifyEnvelopeError) as exc:
        verify_revocation_signature(
            agent_pubkey_base64=agent_key_b64,
            question_id=uuid.uuid4(),  # different qid → digest mismatch
            delegation_hash_hex="02" * 32,
            revocation_signature_base64=sig,
        )
    assert exc.value.reason is RejectionReason.AGENT_SIGNATURE_INVALID


def test_verify_revocation_rejects_swapped_delegation_hash(
    agent_signing_key, agent_key_b64
):
    qid = uuid.uuid4()
    sig = _sign_revocation(agent_signing_key, qid, "03" * 32)
    with pytest.raises(VerifyEnvelopeError) as exc:
        verify_revocation_signature(
            agent_pubkey_base64=agent_key_b64,
            question_id=qid,
            delegation_hash_hex="04" * 32,  # different dhash → digest mismatch
            revocation_signature_base64=sig,
        )
    assert exc.value.reason is RejectionReason.AGENT_SIGNATURE_INVALID


def test_verify_revocation_rejects_garbage_signature(agent_key_b64):
    with pytest.raises(VerifyEnvelopeError) as exc:
        verify_revocation_signature(
            agent_pubkey_base64=agent_key_b64,
            question_id=uuid.uuid4(),
            delegation_hash_hex="05" * 32,
            revocation_signature_base64=base64.b64encode(b"x" * 64).decode("ascii"),
        )
    assert exc.value.reason is RejectionReason.AGENT_SIGNATURE_INVALID


def test_envelope_signature_does_not_verify_as_revocation(
    agent_signing_key, agent_key_b64
):
    """The domain-separation test that matters for real: an attacker who
    captures an envelope signature cannot replay it as a revocation, even
    though both sign with the same agent_key over related fields.
    """
    qid = uuid.uuid4()
    dhash = "06" * 32
    env_digest = envelope_signing_input(qid, "yes", "nonce-x", dhash)
    env_sig = base64.b64encode(
        agent_signing_key.sign(env_digest).signature
    ).decode("ascii")
    with pytest.raises(VerifyEnvelopeError) as exc:
        verify_revocation_signature(
            agent_pubkey_base64=agent_key_b64,
            question_id=qid,
            delegation_hash_hex=dhash,
            revocation_signature_base64=env_sig,
        )
    assert exc.value.reason is RejectionReason.AGENT_SIGNATURE_INVALID


# ----- DB: delete_one_envelope_and_recompute (real Postgres) -------------


async def _seed_question(conn, *, options=None):
    qid = uuid.uuid4()
    if options is None:
        await conn.execute(
            """
            INSERT INTO questions (id, text, nonce, closes_at, status)
            VALUES ($1, $2, $3, $4, 'open')
            """,
            qid,
            "revocation test question",
            "rev-nonce",
            datetime.now(timezone.utc) + timedelta(hours=1),
        )
    else:
        await conn.execute(
            """
            INSERT INTO questions (id, text, nonce, closes_at, status, options)
            VALUES ($1, $2, $3, $4, 'open', $5::jsonb)
            """,
            qid,
            "revocation test question",
            "rev-nonce",
            datetime.now(timezone.utc) + timedelta(hours=1),
            json.dumps(options),
        )
    return qid


async def _insert_and_aggregate(conn, *, qid, uid, answer, preds, options=None):
    await q.insert_envelope(
        conn,
        question_id=qid,
        unique_identifier=uid,
        answer=answer,
        disclosed_predicates=preds,
        agent_signature="sig-" + uid[-4:],
        delegation_hash_hex="hash-" + uid[-4:],
    )
    await q.increment_aggregate(
        conn,
        question_id=qid,
        answer=answer,
        disclosed_predicates=preds,
        options=options,
    )


@pytest.mark.asyncio
async def test_delete_one_envelope_decrements_aggregate(pg_pool):
    """The common case: one of three answers is revoked → total goes 3→2,
    by_predicate buckets reflect the remaining two."""
    async with pg_pool.acquire() as conn:
        qid = await _seed_question(conn)
        users = [
            ("uid-aaaa", "yes", {"region": "EU"}),
            ("uid-bbbb", "no", {"region": "EU"}),
            ("uid-cccc", "yes", {"region": "non-EU"}),
        ]
        for uid, ans, preds in users:
            await _insert_and_aggregate(conn, qid=qid, uid=uid, answer=ans, preds=preds)

        # Revoke the EU "yes".
        found = await q.delete_one_envelope_and_recompute(
            conn, question_id=qid, unique_identifier="uid-aaaa"
        )
        assert found is True

        row = await conn.fetchrow(
            "SELECT total_answers, by_predicate FROM aggregates WHERE question_id = $1",
            qid,
        )
        assert row["total_answers"] == 2
        bp = row["by_predicate"]
        if isinstance(bp, str):
            bp = json.loads(bp)
        assert bp["region:EU"] == {"yes": 0, "no": 1}
        assert bp["region:non-EU"] == {"yes": 1, "no": 0}

        # The envelope itself is gone.
        gone = await conn.fetchval(
            "SELECT 1 FROM envelopes WHERE question_id=$1 AND unique_identifier=$2",
            qid,
            "uid-aaaa",
        )
        assert gone is None


@pytest.mark.asyncio
async def test_delete_last_envelope_drops_aggregate_row(pg_pool):
    """When the last remaining envelope for a question is revoked, the
    aggregate row is deleted entirely — there's nothing left to aggregate."""
    async with pg_pool.acquire() as conn:
        qid = await _seed_question(conn)
        await _insert_and_aggregate(
            conn, qid=qid, uid="uid-only", answer="yes", preds={"region": "EU"}
        )

        found = await q.delete_one_envelope_and_recompute(
            conn, question_id=qid, unique_identifier="uid-only"
        )
        assert found is True

        row = await conn.fetchval(
            "SELECT 1 FROM aggregates WHERE question_id = $1", qid
        )
        assert row is None


@pytest.mark.asyncio
async def test_delete_nonexistent_is_idempotent(pg_pool):
    """Revoking an answer that was never submitted is a no-op, not an error —
    the user (or a retry) gets ``found=False`` and ``accepted=True`` at the
    route layer."""
    async with pg_pool.acquire() as conn:
        qid = await _seed_question(conn)
        found = await q.delete_one_envelope_and_recompute(
            conn, question_id=qid, unique_identifier="uid-never-existed"
        )
        assert found is False


@pytest.mark.asyncio
async def test_delete_does_not_touch_other_questions(pg_pool):
    """A revoke scoped to (qid_A, uid) MUST NOT delete the same uid's envelope
    on qid_B. The composite PK constrains it; this is a regression check."""
    async with pg_pool.acquire() as conn:
        qid_a = await _seed_question(conn)
        qid_b = await _seed_question(conn)
        await _insert_and_aggregate(
            conn, qid=qid_a, uid="uid-x", answer="yes", preds={"region": "EU"}
        )
        await _insert_and_aggregate(
            conn, qid=qid_b, uid="uid-x", answer="no", preds={"region": "EU"}
        )

        await q.delete_one_envelope_and_recompute(
            conn, question_id=qid_a, unique_identifier="uid-x"
        )

        # qid_b's envelope and aggregate untouched.
        still_there = await conn.fetchval(
            "SELECT answer FROM envelopes WHERE question_id=$1 AND unique_identifier=$2",
            qid_b,
            "uid-x",
        )
        assert still_there == "no"
        total = await conn.fetchval(
            "SELECT total_answers FROM aggregates WHERE question_id = $1", qid_b
        )
        assert total == 1
