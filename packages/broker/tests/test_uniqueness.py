"""DB-level uniqueness — same (question_id, unique_identifier) twice → reject.

Runs against a real Postgres via ``testcontainers``. Skipped if Docker
is unavailable. Also exercises the revocations path end-to-end (the DB
lookup in routes/envelopes.py).
"""

from __future__ import annotations

import base64
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from hearme_broker.db import queries as q
from hearme_broker.models.schemas import DelegationToken, Envelope, RejectionReason
from hearme_broker.verify.canonical import delegation_hash
from hearme_broker.verify.delegation import verify_delegation


pytestmark = pytest.mark.asyncio


async def _seed_question(pool, *, nonce: str, status: str = "open") -> uuid.UUID:
    qid = uuid.uuid4()
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO questions (id, text, topic, nonce, closes_at, status)
            VALUES ($1, $2, $3, $4, $5, $6)
            """,
            qid,
            "test question",
            "test",
            nonce,
            datetime.now(timezone.utc) + timedelta(hours=1),
            status,
        )
    return qid


async def test_duplicate_envelope_rejected_at_db(pg_pool, make_token, make_envelope):
    qid = await _seed_question(pg_pool, nonce="seed-nonce-1")
    token_dict = make_token()
    env_dict = make_envelope(
        token_dict, question_id=qid, answer="first", nonce="seed-nonce-1"
    )

    env = Envelope.model_validate(env_dict)
    verified = verify_delegation(env.delegation_token)

    async with pg_pool.acquire() as conn:
        ok1 = await q.insert_envelope(
            conn,
            question_id=env.question_id,
            unique_identifier=verified.token.unique_identifier,
            answer=env.answer,
            disclosed_predicates=verified.token.disclosed_predicates,
            agent_signature=env.agent_signature,
            delegation_hash_hex=verified.delegation_hash,
        )
        assert ok1 is True

        # Second insert with same unique_identifier for same question must fail.
        env2_dict = make_envelope(
            token_dict, question_id=qid, answer="second", nonce="seed-nonce-1"
        )
        env2 = Envelope.model_validate(env2_dict)
        ok2 = await q.insert_envelope(
            conn,
            question_id=env2.question_id,
            unique_identifier=verified.token.unique_identifier,
            answer=env2.answer,
            disclosed_predicates=verified.token.disclosed_predicates,
            agent_signature=env2.agent_signature,
            delegation_hash_hex=verified.delegation_hash,
        )
        assert ok2 is False


async def test_revocation_lookup(pg_pool, make_token):
    token_dict = make_token()
    dhash = delegation_hash(token_dict)
    async with pg_pool.acquire() as conn:
        assert await q.is_revoked(conn, dhash) is False
        await conn.execute(
            "INSERT INTO revocations (delegation_hash) VALUES ($1)", dhash
        )
        assert await q.is_revoked(conn, dhash) is True


async def test_nullifier_binding_persists_and_is_idempotent(pg_pool, make_token):
    """First envelope binds (nullifier, agent_key); refresh under same key is OK."""
    nullifier = base64.b64encode(b"\x33" * 32).decode("ascii")
    raw = make_token(unique_identifier=nullifier)
    agent_key = raw["agent_key"]

    async with pg_pool.acquire() as conn:
        assert await q.get_bound_agent_key(conn, nullifier) is None
        ok = await q.bind_nullifier_agent(
            conn, nullifier=nullifier, agent_key=agent_key
        )
        assert ok is True
        bound = await q.get_bound_agent_key(conn, nullifier)
        assert bound == agent_key

        # Refresh with the same agent_key — UPDATE last_seen_at; row count unchanged.
        ok = await q.bind_nullifier_agent(
            conn, nullifier=nullifier, agent_key=agent_key
        )
        assert ok is True
        cnt = await conn.fetchval(
            "SELECT count(*) FROM nullifiers WHERE nullifier = $1", nullifier
        )
        assert cnt == 1


async def test_nullifier_binding_rejects_different_agent_key(pg_pool, make_token):
    """Same passport (nullifier) showing up under a NEW agent_key is the
    identity-already-bound case. The UPSERT's WHERE guard refuses to
    overwrite the existing row, so the binding stays intact and the
    envelope route will reject the second envelope."""
    nullifier = base64.b64encode(b"\x44" * 32).decode("ascii")
    first = make_token(unique_identifier=nullifier)
    other_agent_b64 = base64.b64encode(b"\x77" * 32).decode("ascii")

    async with pg_pool.acquire() as conn:
        ok = await q.bind_nullifier_agent(
            conn, nullifier=nullifier, agent_key=first["agent_key"]
        )
        assert ok is True
        # Stray attempt to bind a different agent_key under the same nullifier.
        ok = await q.bind_nullifier_agent(
            conn, nullifier=nullifier, agent_key=other_agent_b64
        )
        assert ok is False
        # Binding still maps to the original agent_key.
        bound = await q.get_bound_agent_key(conn, nullifier)
        assert bound == first["agent_key"]


async def test_different_uids_can_both_answer(pg_pool, make_token, make_envelope):
    qid = await _seed_question(pg_pool, nonce="seed-nonce-2")
    token_a = make_token(
        unique_identifier=base64.b64encode(b"\x0a" * 32).decode("ascii"),
        disclosed_predicates={"region": "EU"},
    )
    token_b = make_token(
        unique_identifier=base64.b64encode(b"\x0b" * 32).decode("ascii"),
        disclosed_predicates={"region": "non-EU"},
    )

    async with pg_pool.acquire() as conn:
        for t in (token_a, token_b):
            env_dict = make_envelope(t, question_id=qid, answer="x", nonce="seed-nonce-2")
            env = Envelope.model_validate(env_dict)
            verified = verify_delegation(env.delegation_token)
            ok = await q.insert_envelope(
                conn,
                question_id=env.question_id,
                unique_identifier=verified.token.unique_identifier,
                answer=env.answer,
                disclosed_predicates=verified.token.disclosed_predicates,
                agent_signature=env.agent_signature,
                delegation_hash_hex=verified.delegation_hash,
            )
            assert ok is True
