"""DB-level uniqueness + the registrations registry (atomic Sybil bind).

Runs against a real Postgres via ``testcontainers``. Skipped if Docker is
unavailable. Also exercises the revocations path used by routes/envelopes.py.
"""

from __future__ import annotations

import base64
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from hearme_broker.db import queries as q
from hearme_broker.models.schemas import Envelope
from hearme_broker.verify.canonical import delegation_hash
from hearme_broker.verify.delegation import verify_delegation


pytestmark = pytest.mark.asyncio


def _window():
    now = datetime.now(timezone.utc)
    return now, now + timedelta(days=90)


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
    env = Envelope.model_validate(
        make_envelope(token_dict, question_id=qid, answer="first", nonce="seed-nonce-1")
    )
    verified = verify_delegation(env.delegation_token)

    async with pg_pool.acquire() as conn:
        ok1 = await q.insert_envelope(
            conn,
            question_id=env.question_id,
            unique_identifier=verified.unique_identifier,
            answer=env.answer,
            disclosed_predicates=verified.token.disclosed_predicates,
            agent_signature=env.agent_signature,
            delegation_hash_hex=verified.delegation_hash,
        )
        assert ok1 is True

        ok2 = await q.insert_envelope(
            conn,
            question_id=env.question_id,
            unique_identifier=verified.unique_identifier,
            answer="second",
            disclosed_predicates=verified.token.disclosed_predicates,
            agent_signature=env.agent_signature,
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


async def test_registration_created_then_refreshed_same_key(pg_pool):
    nullifier = "self:" + base64.b64encode(b"\x33" * 32).decode("ascii")
    agent_key = base64.b64encode(b"\x33" * 32).decode("ascii")
    issued, expires = _window()

    async with pg_pool.acquire() as conn:
        assert await q.get_registration(conn, nullifier) is None
        status = await q.upsert_registration(
            conn,
            unique_identifier=nullifier,
            agent_key=agent_key,
            disclosed_predicates={"region": "EU", "age_band": "18+"},
            issued_at=issued,
            expires_at=expires,
        )
        assert status == "created"

        row = await q.get_registration(conn, nullifier)
        assert row["agent_key"] == agent_key
        assert row["revoked_at"] is None

        # Re-register with the SAME agent_key (refresh): one row, predicates updated.
        status = await q.upsert_registration(
            conn,
            unique_identifier=nullifier,
            agent_key=agent_key,
            disclosed_predicates={"region": "EU", "age_band": "35-49"},
            issued_at=issued,
            expires_at=expires,
        )
        assert status == "refreshed"
        cnt = await conn.fetchval(
            "SELECT count(*) FROM registrations WHERE unique_identifier = $1",
            nullifier,
        )
        assert cnt == 1
        row = await q.get_registration(conn, nullifier)
        assert row["agent_key"] == agent_key


async def test_registration_rejects_different_agent_key(pg_pool):
    """Same passport (nullifier) under a NEW agent_key is identity-already-bound."""
    nullifier = "self:" + base64.b64encode(b"\x44" * 32).decode("ascii")
    first_key = base64.b64encode(b"\x44" * 32).decode("ascii")
    other_key = base64.b64encode(b"\x77" * 32).decode("ascii")
    issued, expires = _window()

    async with pg_pool.acquire() as conn:
        assert (
            await q.upsert_registration(
                conn,
                unique_identifier=nullifier,
                agent_key=first_key,
                disclosed_predicates={"region": "EU"},
                issued_at=issued,
                expires_at=expires,
            )
            == "created"
        )
        # Different agent_key, not revoked → must refuse.
        assert (
            await q.upsert_registration(
                conn,
                unique_identifier=nullifier,
                agent_key=other_key,
                disclosed_predicates={"region": "EU"},
                issued_at=issued,
                expires_at=expires,
            )
            is None
        )
        row = await q.get_registration(conn, nullifier)
        assert row["agent_key"] == first_key


async def test_registration_rebind_allowed_after_revocation(pg_pool):
    nullifier = "self:" + base64.b64encode(b"\x55" * 32).decode("ascii")
    first_key = base64.b64encode(b"\x55" * 32).decode("ascii")
    new_key = base64.b64encode(b"\x66" * 32).decode("ascii")
    issued, expires = _window()

    async with pg_pool.acquire() as conn:
        await q.upsert_registration(
            conn,
            unique_identifier=nullifier,
            agent_key=first_key,
            disclosed_predicates={"region": "EU"},
            issued_at=issued,
            expires_at=expires,
        )
        await conn.execute(
            "UPDATE registrations SET revoked_at = now() WHERE unique_identifier = $1",
            nullifier,
        )
        # After revocation a different agent_key may claim the nullifier.
        status = await q.upsert_registration(
            conn,
            unique_identifier=nullifier,
            agent_key=new_key,
            disclosed_predicates={"region": "EU"},
            issued_at=issued,
            expires_at=expires,
        )
        assert status == "refreshed"
        row = await q.get_registration(conn, nullifier)
        assert row["agent_key"] == new_key
        assert row["revoked_at"] is None


async def test_different_uids_can_both_answer(pg_pool, make_token, make_envelope):
    qid = await _seed_question(pg_pool, nonce="seed-nonce-2")
    token_a = make_token(
        unique_identifier="self:" + base64.b64encode(b"\x0a" * 32).decode("ascii"),
        disclosed_predicates={"region": "EU"},
    )
    token_b = make_token(
        unique_identifier="self:" + base64.b64encode(b"\x0b" * 32).decode("ascii"),
        disclosed_predicates={"region": "NA"},
    )

    async with pg_pool.acquire() as conn:
        for t in (token_a, token_b):
            env = Envelope.model_validate(
                make_envelope(t, question_id=qid, answer="x", nonce="seed-nonce-2")
            )
            verified = verify_delegation(env.delegation_token)
            ok = await q.insert_envelope(
                conn,
                question_id=env.question_id,
                unique_identifier=verified.unique_identifier,
                answer=env.answer,
                disclosed_predicates=verified.token.disclosed_predicates,
                agent_signature=env.agent_signature,
                delegation_hash_hex=verified.delegation_hash,
            )
            assert ok is True
