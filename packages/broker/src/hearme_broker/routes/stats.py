"""GET /v1/stats — public, privacy-safe site-wide counts.

The web role is revoked from ``registrations`` and ``envelopes`` (the privacy
boundary in db/init/02-roles.sh), so the broker — which owns those tables — is
the only place agent/respondent counts can be computed. This endpoint returns
aggregate COUNTs only; no nullifiers, agent keys, or per-row data cross the
boundary. The public stats page (packages/web) fetches it.
"""

from __future__ import annotations

from fastapi import APIRouter

from ..db import get_pool
from ..db import queries as q
from ..models.schemas import PlatformStats

router = APIRouter(prefix="/v1", tags=["stats"])


@router.get("/stats", response_model=PlatformStats)
async def get_stats() -> PlatformStats:
    pool = get_pool()
    async with pool.acquire() as conn:
        row = await q.platform_stats(conn)

    questions = int(row["questions"])
    total_answers = int(row["total_answers"])
    avg = total_answers / questions if questions else 0.0
    return PlatformStats(
        registered_agents=int(row["registered_agents"]),
        questions=questions,
        total_answers=total_answers,
        respondents=int(row["respondents"]),
        answered_questions=int(row["answered_questions"]),
        avg_answers_per_question=round(avg, 2),
    )
