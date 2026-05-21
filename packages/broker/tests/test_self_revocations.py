from __future__ import annotations

import base64
import json
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from hearme_broker.db import queries as q
from hearme_broker.self_revocations import (
    extract_nullifier_from_log,
    nullifier_candidates,
)


def test_nullifier_candidates_include_decimal_hex_and_self_prefixed_forms():
    raw = "0x" + ("0" * 63) + "a"

    assert nullifier_candidates(raw) == [
        "0x000000000000000000000000000000000000000000000000000000000000000a",
        "0xa",
        "10",
        "self:0x000000000000000000000000000000000000000000000000000000000000000a",
        "self:0xa",
        "self:10",
    ]


def test_extract_nullifier_from_indexed_topic_or_data_word():
    word_a = "0x" + ("0" * 63) + "a"
    word_b = "0x" + ("0" * 63) + "b"
    entry = {
        "topics": ["0xsig", word_a],
        "data": "0x" + ("0" * 64) + word_b[2:],
    }

    assert extract_nullifier_from_log(entry, topic_index=1, data_word_index=-1) == word_a
    assert extract_nullifier_from_log(entry, topic_index=-1, data_word_index=1) == word_b


@pytest.mark.asyncio
async def test_self_invalidation_revokes_registration_deletes_votes_and_recomputes(
    pg_pool,
):
    qid = uuid.uuid4()
    invalid_uid = "self:10"
    other_uid = "self:11"
    now = datetime.now(timezone.utc)
    agent_key = base64.b64encode(b"\x44" * 32).decode("ascii")

    async with pg_pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO questions (id, text, nonce, closes_at, status)
            VALUES ($1, $2, $3, $4, 'open')
            """,
            qid,
            "revocation aggregate question",
            "revocation-nonce",
            now + timedelta(hours=1),
        )
        for uid in (invalid_uid, other_uid):
            await q.upsert_registration(
                conn,
                unique_identifier=uid,
                agent_key=agent_key,
                disclosed_predicates={"region": "EU"},
                issued_at=now,
                expires_at=now + timedelta(days=90),
            )
        await q.insert_envelope(
            conn,
            question_id=qid,
            unique_identifier=invalid_uid,
            answer="remove me",
            disclosed_predicates={"region": "EU", "age_band": "25-34"},
            agent_signature="sig-a",
            delegation_hash_hex="hash-a",
        )
        await q.increment_aggregate(
            conn,
            question_id=qid,
            disclosed_predicates={"region": "EU", "age_band": "25-34"},
        )
        await q.insert_envelope(
            conn,
            question_id=qid,
            unique_identifier=other_uid,
            answer="keep me",
            disclosed_predicates={"region": "NA", "age_band": "35-49"},
            agent_signature="sig-b",
            delegation_hash_hex="hash-b",
        )
        await q.increment_aggregate(
            conn,
            question_id=qid,
            disclosed_predicates={"region": "NA", "age_band": "35-49"},
        )

        result = await q.invalidate_first_matching_registration_and_votes(
            conn,
            candidates=nullifier_candidates("0x" + ("0" * 63) + "a"),
            source="self_onchain",
            chain_id="celo",
            block_number=123,
            log_index=4,
            tx_hash="0xtx",
        )

        assert result == {
            "recorded": True,
            "registration_revoked": True,
            "deleted_envelopes": 1,
            "affected_questions": 1,
        }
        invalid_registration = await q.get_registration(conn, invalid_uid)
        assert invalid_registration is not None
        assert invalid_registration["revoked_at"] is not None

        remaining = await conn.fetch(
            "SELECT unique_identifier FROM envelopes WHERE question_id = $1",
            qid,
        )
        assert [r["unique_identifier"] for r in remaining] == [other_uid]

        agg = await conn.fetchrow(
            "SELECT total_answers, by_predicate FROM aggregates WHERE question_id = $1",
            qid,
        )
        assert agg["total_answers"] == 1
        by_predicate = agg["by_predicate"]
        if isinstance(by_predicate, str):
            by_predicate = json.loads(by_predicate)
        assert dict(by_predicate) == {
            "region:NA": 1,
            "age_band:35-49": 1,
        }
