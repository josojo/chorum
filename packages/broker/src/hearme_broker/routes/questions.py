"""GET /v1/questions/open — agents poll here.

ARCHITECTURE.md §5: returns rows where ``status='open' AND closes_at > now()``
and, if ``since`` is provided, ``created_at >= since``. Each row carries
``created_at`` as the server-side cursor source plus the per-question ``nonce``
the agent will bind into the envelope signature.
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query

from ..db import get_pool
from ..db import queries as q
from ..models.schemas import Question

router = APIRouter(prefix="/v1", tags=["questions"])


def _parse_since(since: str | None) -> datetime | None:
    if since is None:
        return None
    # Accept '...Z' as UTC — Python pre-3.11 wouldn't but FastAPI/Pydantic
    # routes don't bind this for us since we want a 400, not a Pydantic 422,
    # on malformed input.
    try:
        if since.endswith("Z"):
            since = since[:-1] + "+00:00"
        parsed = datetime.fromisoformat(since)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed
    except ValueError as exc:
        raise HTTPException(400, f"invalid 'since' value: {exc}") from exc


@router.get("/questions/open", response_model=list[Question])
async def list_open_questions(since: str | None = Query(default=None)) -> list[Question]:
    since_dt = _parse_since(since)
    pool = get_pool()
    async with pool.acquire() as conn:
        rows = await q.list_open_questions(conn, since=since_dt)
    return [
        Question(
            question_id=r["id"],
            text=r["text"],
            topic=r["topic"],
            options=r["options"],
            created_at=r["created_at"],
            closes_at=r["closes_at"],
            nonce=r["nonce"],
        )
        for r in rows
    ]
