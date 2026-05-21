"""Aggregate helpers — by_predicate must match hand computation.

Pure-function test for ``compute_by_predicate`` plus an end-to-end run
against real Postgres for incremental aggregate updates.
"""

from __future__ import annotations

import base64
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from hearme_broker.aggregates import compute_by_predicate
from hearme_broker.db import queries as q


def test_compute_by_predicate_hand_computation():
    envelopes = [
        {"disclosed_predicates": {"region": "EU", "age_band": "25-34"}},
        {"disclosed_predicates": {"region": "EU", "age_band": "35-44"}},
        {"disclosed_predicates": {"region": "non-EU", "age_band": "25-34"}},
        {"disclosed_predicates": {"region": "EU", "age_band": "25-34"}},
    ]
    assert compute_by_predicate(envelopes) == {
        "region:EU": 3,
        "region:non-EU": 1,
        "age_band:25-34": 3,
        "age_band:35-44": 1,
    }


def test_compute_by_predicate_empty():
    assert compute_by_predicate([]) == {}


def test_compute_by_predicate_handles_missing_field():
    envelopes = [
        {"disclosed_predicates": None},
        {"disclosed_predicates": {}},
        {"disclosed_predicates": {"region": "EU"}},
    ]
    assert compute_by_predicate(envelopes) == {"region:EU": 1}


def test_compute_by_predicate_handles_json_string_from_asyncpg():
    envelopes = [
        {"disclosed_predicates": '{"region":"EU","age_band":"25-34"}'},
    ]
    assert compute_by_predicate(envelopes) == {"region:EU": 1, "age_band:25-34": 1}


pytestmark_async = pytest.mark.asyncio


@pytest.mark.asyncio
async def test_increment_aggregate_against_real_pg(pg_pool, make_token, make_envelope):
    # Seed 3 accepted envelopes for one question; assert aggregate increments match.
    qid = uuid.uuid4()
    async with pg_pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO questions (id, text, nonce, closes_at, status)
            VALUES ($1, $2, $3, $4, 'open')
            """,
            qid,
            "agg question",
            "agg-nonce",
            datetime.now(timezone.utc) + timedelta(hours=1),
        )

        # Three distinct users with mixed predicates.
        users = [
            (base64.b64encode(b"\x10" * 32).decode("ascii"), {"region": "EU", "age_band": "25-34"}),
            (base64.b64encode(b"\x11" * 32).decode("ascii"), {"region": "EU", "age_band": "35-44"}),
            (base64.b64encode(b"\x12" * 32).decode("ascii"), {"region": "non-EU", "age_band": "25-34"}),
        ]
        for uid, preds in users:
            await q.insert_envelope(
                conn,
                question_id=qid,
                unique_identifier=uid,
                answer="x",
                disclosed_predicates=preds,
                agent_signature="sig",
                delegation_hash_hex="hash",
            )
            await q.increment_aggregate(
                conn,
                question_id=qid,
                disclosed_predicates=preds,
            )

        row = await conn.fetchrow(
            "SELECT total_answers, by_predicate FROM aggregates WHERE question_id = $1",
            qid,
        )
        assert row["total_answers"] == 3
        import json as _json
        by_pred = row["by_predicate"]
        if isinstance(by_pred, str):
            by_pred = _json.loads(by_pred)
        assert by_pred == {
            "region:EU": 2,
            "region:non-EU": 1,
            "age_band:25-34": 2,
            "age_band:35-44": 1,
        }
