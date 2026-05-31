"""Verifies that ``list_open_questions`` hides rows whose topic is NULL.

The classifier service (packages/classifier) is the only path that turns a
NULL-topic row into a tagged row. Until it has, the broker MUST NOT serve
the question — otherwise an asker could effectively bypass the skill's
sensitive-topic gate (which keys on the asker-INDEPENDENT topic token) by
omitting the topic field. This test pins that contract at the SQL layer.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from hearme_broker.db import queries as q


pytestmark = pytest.mark.asyncio


async def _insert_question(
    pool,
    *,
    topic: str | None,
    closes_in_hours: int = 1,
    status: str = "open",
) -> uuid.UUID:
    qid = uuid.uuid4()
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO questions (id, text, topic, nonce, closes_at, status)
            VALUES ($1, $2, $3, $4, $5, $6)
            """,
            qid,
            f"question {qid}",
            topic,
            f"nonce-{qid}",
            datetime.now(timezone.utc) + timedelta(hours=closes_in_hours),
            status,
        )
    return qid


async def test_list_open_questions_hides_null_topic(pg_pool):
    classified = await _insert_question(pg_pool, topic="ai")
    null_topic = await _insert_question(pg_pool, topic=None)

    async with pg_pool.acquire() as conn:
        rows = await q.list_open_questions(conn, since=None)

    ids = {r["id"] for r in rows}
    assert classified in ids
    assert null_topic not in ids


async def test_list_open_questions_serves_classified_rows(pg_pool):
    qid = await _insert_question(pg_pool, topic="health legal")
    async with pg_pool.acquire() as conn:
        rows = await q.list_open_questions(conn, since=None)
    matching = [r for r in rows if r["id"] == qid]
    assert len(matching) == 1
    assert matching[0]["topic"] == "health legal"


async def test_since_cursor_still_excludes_null_topic(pg_pool):
    # Even when the agent passes a cursor, NULL-topic rows must not leak through.
    classified = await _insert_question(pg_pool, topic="food")
    null_topic = await _insert_question(pg_pool, topic=None)
    very_old = datetime.now(timezone.utc) - timedelta(days=365)
    async with pg_pool.acquire() as conn:
        rows = await q.list_open_questions(conn, since=very_old)
    ids = {r["id"] for r in rows}
    assert classified in ids
    assert null_topic not in ids
