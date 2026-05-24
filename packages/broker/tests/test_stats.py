"""platform_stats — site-wide counts against real Postgres.

Seeds questions, registrations (one revoked) and envelopes from a few distinct
users, then asserts the privacy-safe COUNTs the public /v1/stats page reads.
"""

from __future__ import annotations

import base64
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from hearme_broker.db import queries as q


def _uid(b: int) -> str:
    return base64.b64encode(bytes([b]) * 32).decode("ascii")


@pytest.mark.asyncio
async def test_platform_stats_counts_against_real_pg(pg_pool):
    now = datetime.now(timezone.utc)

    async with pg_pool.acquire() as conn:
        # Two questions; only the first will receive answers.
        q1, q2 = uuid.uuid4(), uuid.uuid4()
        for qid, text in ((q1, "answered q"), (q2, "unanswered q")):
            await conn.execute(
                """
                INSERT INTO questions (id, text, nonce, closes_at, status)
                VALUES ($1, $2, $3, $4, 'open')
                """,
                qid,
                text,
                f"nonce-{qid}",
                now + timedelta(hours=1),
            )

        # Three registrations, one revoked -> 2 active "registered agents".
        regs = [(_uid(0xA0), None), (_uid(0xA1), None), (_uid(0xA2), now)]
        for i, (uid, revoked) in enumerate(regs):
            await conn.execute(
                """
                INSERT INTO registrations
                  (unique_identifier, agent_key, disclosed_predicates,
                   issued_at, expires_at, revoked_at)
                VALUES ($1, $2, '{}'::jsonb, $3, $4, $5)
                """,
                uid,
                _uid(0xB0 + i),
                now,
                now + timedelta(days=30),
                revoked,
            )

        # Two distinct respondents answer q1 -> 2 answers, 2 respondents,
        # 1 answered question.
        for uid, ans in ((_uid(0xA0), "Yes"), (_uid(0xA1), "No")):
            await q.insert_envelope(
                conn,
                question_id=q1,
                unique_identifier=uid,
                answer=ans,
                disclosed_predicates={"region": "EU"},
                agent_signature="sig",
                delegation_hash_hex=f"hash-{uid}",
            )

        stats = await q.platform_stats(conn)

    assert stats["registered_agents"] == 2
    assert stats["questions"] == 2
    assert stats["total_answers"] == 2
    assert stats["respondents"] == 2
    assert stats["answered_questions"] == 1
