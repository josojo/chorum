"""All SQL the broker runs. Parameterized; no f-string SQL anywhere.

Group by responsibility so the audit boundary is obvious:
- ``questions_*`` — read-only against ``questions`` (per role grants).
- ``revocations_*`` — read-only against ``revocations`` for verify-time checks.
- ``envelopes_*`` — INSERT path only.
- ``aggregates_*`` — incremental update on each accepted insert.
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any, Sequence
from uuid import UUID

import asyncpg

from ..aggregates import classify_answer, compute_by_predicate


# ----- questions ---------------------------------------------------------


def _normalize_options(raw: Any) -> list[str]:
    """asyncpg returns jsonb as either a parsed list or a raw JSON string."""
    if raw is None:
        return ["yes", "no"]
    if isinstance(raw, str):
        raw = json.loads(raw)
    if isinstance(raw, list):
        return [str(x) for x in raw]
    return ["yes", "no"]


async def list_open_questions(
    conn: asyncpg.Connection,
    *,
    since: datetime | None,
) -> list[dict[str, Any]]:
    """Open + not-yet-closed + topic-classified questions.

    The ``topic IS NOT NULL`` guard is the fail-closed gate against
    asker-controlled tagging: questions are inserted with NULL topic and then
    classified by ``packages/classifier`` from the question text. Until the
    classifier has assigned a token from the canonical taxonomy, the question
    is invisible to agents — so an asker can't sneak a health question past
    the skill's privacy gate by mislabelling it ``ai``. If the classifier
    service is down, new questions accumulate as NULL and are simply not
    served; existing classified rows continue to be served.

    ``since`` filters by ``created_at >= since`` so polling agents can cursor.
    """
    if since is None:
        rows = await conn.fetch(
            """
            SELECT id, text, topic, options, created_at, closes_at, nonce
            FROM questions
            WHERE status = 'open' AND closes_at > now() AND topic IS NOT NULL
            ORDER BY created_at ASC
            """
        )
    else:
        rows = await conn.fetch(
            """
            SELECT id, text, topic, options, created_at, closes_at, nonce
            FROM questions
            WHERE status = 'open' AND closes_at > now() AND topic IS NOT NULL
              AND created_at >= $1
            ORDER BY created_at ASC
            """,
            since,
        )
    return [{**dict(r), "options": _normalize_options(r["options"])} for r in rows]


async def get_question_for_verify(
    conn: asyncpg.Connection, question_id: UUID
) -> dict[str, Any] | None:
    row = await conn.fetchrow(
        """
        SELECT id, status, closes_at, nonce, scope, country, continent, options
        FROM questions
        WHERE id = $1
        """,
        question_id,
    )
    if row is None:
        return None
    out: dict[str, Any] = dict(row)
    out["options"] = _normalize_options(row["options"])
    return out


# ----- revocations -------------------------------------------------------


async def is_revoked(conn: asyncpg.Connection, delegation_hash_hex: str) -> bool:
    row = await conn.fetchrow(
        "SELECT 1 FROM revocations WHERE delegation_hash = $1",
        delegation_hash_hex,
    )
    return row is not None


# ----- registrations (nullifier registry) --------------------------------


async def upsert_registration(
    conn: asyncpg.Connection,
    *,
    unique_identifier: str,
    agent_key: str,
    disclosed_predicates: dict[str, str],
    issued_at: datetime,
    expires_at: datetime,
) -> str | None:
    """Atomically bind ``unique_identifier`` (nullifier) to ``agent_key``.

    Returns:
      - ``"created"``   — first registration of this nullifier.
      - ``"refreshed"`` — re-registration with the SAME agent_key (or after a
                          prior revocation): predicates/expiry updated.
      - ``None``        — the nullifier is already bound to a DIFFERENT,
                          non-revoked agent_key (the Sybil bind; reject).

    The single INSERT/ON CONFLICT statement holds the PK index lock, so two
    concurrent first registrations for one nullifier under different agent
    keys cannot both succeed.
    """
    row = await conn.fetchrow(
        """
        INSERT INTO registrations (
          unique_identifier, agent_key, disclosed_predicates,
          issued_at, expires_at, revoked_at
        ) VALUES ($1, $2, $3::jsonb, $4, $5, NULL)
        ON CONFLICT (unique_identifier) DO UPDATE
        SET agent_key = EXCLUDED.agent_key,
            disclosed_predicates = EXCLUDED.disclosed_predicates,
            issued_at = EXCLUDED.issued_at,
            expires_at = EXCLUDED.expires_at,
            revoked_at = NULL
        WHERE registrations.agent_key = EXCLUDED.agent_key
           OR registrations.revoked_at IS NOT NULL
        RETURNING (xmax = 0) AS inserted
        """,
        unique_identifier,
        agent_key,
        json.dumps(disclosed_predicates),
        issued_at,
        expires_at,
    )
    if row is None:
        return None
    return "created" if row["inserted"] else "refreshed"


async def get_registration(
    conn: asyncpg.Connection, unique_identifier: str
) -> dict[str, Any] | None:
    """Return the registry row for ``unique_identifier`` (None if absent)."""
    row = await conn.fetchrow(
        """
        SELECT unique_identifier, agent_key, disclosed_predicates,
               issued_at, expires_at, revoked_at
        FROM registrations
        WHERE unique_identifier = $1
        """,
        unique_identifier,
    )
    return dict(row) if row else None


async def invalidate_registration_and_votes(
    conn: asyncpg.Connection,
    *,
    unique_identifier: str,
    source: str,
    chain_id: str | None,
    block_number: int,
    log_index: int,
    tx_hash: str,
) -> dict[str, Any]:
    """Apply a Self on-chain invalidation for one Hearme nullifier.

    This is intentionally stronger than setting ``registrations.revoked_at``:
    accepted envelopes for the invalidated nullifier are removed and every
    affected aggregate is recomputed in the same transaction. After this returns,
    the nullifier can neither submit future votes nor remain counted in old
    question aggregates.
    """
    async with conn.transaction():
        inserted_invalidation = await conn.fetchval(
            """
            INSERT INTO self_nullifier_invalidations (
              unique_identifier, source, chain_id, block_number, log_index, tx_hash
            ) VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (unique_identifier) DO NOTHING
            RETURNING 1
            """,
            unique_identifier,
            source,
            chain_id,
            block_number,
            log_index,
            tx_hash,
        )

        revoked = await conn.fetchval(
            """
            UPDATE registrations
            SET revoked_at = COALESCE(revoked_at, now())
            WHERE unique_identifier = $1
            RETURNING 1
            """,
            unique_identifier,
        )

        affected_rows = await conn.fetch(
            """
            DELETE FROM envelopes
            WHERE unique_identifier = $1
            RETURNING question_id
            """,
            unique_identifier,
        )
        affected_question_ids = sorted({r["question_id"] for r in affected_rows})

        for question_id in affected_question_ids:
            remaining = await conn.fetch(
                """
                SELECT answer, disclosed_predicates
                FROM envelopes
                WHERE question_id = $1
                """,
                question_id,
            )
            envelopes = [dict(r) for r in remaining]
            total = len(envelopes)
            if total == 0:
                await conn.execute(
                    "DELETE FROM aggregates WHERE question_id = $1",
                    question_id,
                )
                continue
            options_row = await conn.fetchval(
                "SELECT options FROM questions WHERE id = $1",
                question_id,
            )
            options = _normalize_options(options_row)
            by_predicate = compute_by_predicate(envelopes, options)
            await conn.execute(
                """
                INSERT INTO aggregates (question_id, total_answers, by_predicate, updated_at)
                VALUES ($1, $2, $3::jsonb, now())
                ON CONFLICT (question_id) DO UPDATE
                SET total_answers = EXCLUDED.total_answers,
                    by_predicate = EXCLUDED.by_predicate,
                    updated_at = now()
                """,
                question_id,
                total,
                json.dumps(by_predicate),
            )

    return {
        "recorded": inserted_invalidation is not None,
        "registration_revoked": revoked is not None,
        "deleted_envelopes": len(affected_rows),
        "affected_questions": len(affected_question_ids),
    }


async def invalidate_first_matching_registration_and_votes(
    conn: asyncpg.Connection,
    *,
    candidates: list[str],
    source: str,
    chain_id: str | None,
    block_number: int,
    log_index: int,
    tx_hash: str,
) -> dict[str, Any] | None:
    """Find a registration by any normalized Self nullifier form and invalidate it.

    The invalidation is also recorded for every candidate form so a chain event
    that arrives before a matching Hearme registration still blocks a stale proof
    from registering later.
    """
    if not candidates:
        return None
    unique_identifier = await conn.fetchval(
        """
        SELECT unique_identifier
        FROM registrations
        WHERE unique_identifier = ANY($1::text[])
        ORDER BY unique_identifier
        LIMIT 1
        """,
        candidates,
    )
    if unique_identifier is None:
        for candidate in candidates:
            await conn.execute(
                """
                INSERT INTO self_nullifier_invalidations (
                  unique_identifier, source, chain_id, block_number, log_index, tx_hash
                ) VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (unique_identifier) DO NOTHING
                """,
                candidate,
                source,
                chain_id,
                block_number,
                log_index,
                tx_hash,
            )
        return {
            "recorded": True,
            "registration_revoked": False,
            "deleted_envelopes": 0,
            "affected_questions": 0,
        }
    return await invalidate_registration_and_votes(
        conn,
        unique_identifier=unique_identifier,
        source=source,
        chain_id=chain_id,
        block_number=block_number,
        log_index=log_index,
        tx_hash=tx_hash,
    )


async def is_self_nullifier_invalidated(
    conn: asyncpg.Connection, unique_identifier: str
) -> bool:
    row = await conn.fetchrow(
        """
        SELECT 1
        FROM self_nullifier_invalidations
        WHERE unique_identifier = $1
        """,
        unique_identifier,
    )
    return row is not None


async def get_self_chain_cursor(conn: asyncpg.Connection, name: str) -> int | None:
    row = await conn.fetchrow(
        "SELECT last_block FROM self_chain_cursors WHERE name = $1",
        name,
    )
    return int(row["last_block"]) if row else None


async def upsert_self_chain_cursor(
    conn: asyncpg.Connection, *, name: str, last_block: int
) -> None:
    await conn.execute(
        """
        INSERT INTO self_chain_cursors (name, last_block, updated_at)
        VALUES ($1, $2, now())
        ON CONFLICT (name) DO UPDATE
        SET last_block = EXCLUDED.last_block,
            updated_at = now()
        """,
        name,
        last_block,
    )


# ----- envelopes ---------------------------------------------------------


async def insert_envelope(
    conn: asyncpg.Connection,
    *,
    question_id: UUID,
    unique_identifier: str,
    answer: str,
    disclosed_predicates: dict[str, str],
    agent_signature: str,
    delegation_hash_hex: str,
) -> bool:
    """INSERT one envelope; return False if PK collision (duplicate).

    The composite PK ``(question_id, unique_identifier)`` is the hard
    Sybil-resistance gate. We do an explicit ON CONFLICT DO NOTHING and
    return False so the caller can map to RejectionReason.DUPLICATE.
    """
    result = await conn.execute(
        """
        INSERT INTO envelopes (
          question_id, unique_identifier, answer, disclosed_predicates,
          agent_signature, delegation_hash
        ) VALUES ($1, $2, $3, $4::jsonb, $5, $6)
        ON CONFLICT (question_id, unique_identifier) DO NOTHING
        """,
        question_id,
        unique_identifier,
        answer,
        json.dumps(disclosed_predicates),
        agent_signature,
        delegation_hash_hex,
    )
    # asyncpg returns 'INSERT 0 1' on success, 'INSERT 0 0' on conflict.
    return result.endswith(" 1")


# ----- aggregates --------------------------------------------------------


async def increment_aggregate(
    conn: asyncpg.Connection,
    *,
    question_id: UUID,
    answer: str,
    disclosed_predicates: dict[str, str],
    options: Sequence[str] | None = None,
) -> None:
    """Increment the aggregate row for one newly accepted envelope.

    Each disclosed (predicate, value) bucket records the classified option,
    e.g. ``{"yes": n, "no": m}`` for the default yes/no poll, or
    ``{"pizza": n, "pasta": m, "sushi": k}`` for an N-option poll.

    The advisory transaction lock serializes first-writer creation of the
    aggregate row for a question. After that, ``FOR UPDATE`` locks only the
    single aggregate row, avoiding the previous full-envelope scan on every
    insert.
    """
    if not options:
        options = ("yes", "no")
    await conn.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
        str(question_id),
    )
    row = await conn.fetchrow(
        """
        SELECT total_answers, by_predicate
        FROM aggregates
        WHERE question_id = $1
        FOR UPDATE
        """,
        question_id,
    )
    choice = classify_answer(answer, options)
    empty: dict[str, int] = {opt: 0 for opt in options}
    delta: dict[str, dict[str, int]] = {}
    for key, value in (disclosed_predicates or {}).items():
        predicate_key = f"{key}:{value}"
        bucket = delta.setdefault(predicate_key, dict(empty))
        if choice is not None:
            bucket[choice] = bucket.get(choice, 0) + 1

    if row is None:
        await conn.execute(
            """
            INSERT INTO aggregates (question_id, total_answers, by_predicate, updated_at)
            VALUES ($1, 1, $2::jsonb, now())
            """,
            question_id,
            json.dumps(delta),
        )
        return

    by_predicate = row["by_predicate"]
    if isinstance(by_predicate, str):
        by_predicate = json.loads(by_predicate)
    by_predicate = dict(by_predicate or {})
    for key, bucket in delta.items():
        current = dict(by_predicate.get(key) or {})
        merged = dict(empty)
        merged.update({k: int(v) for k, v in current.items()})
        for opt, n in bucket.items():
            merged[opt] = merged.get(opt, 0) + n
        by_predicate[key] = merged

    await conn.execute(
        """
        UPDATE aggregates
        SET total_answers = total_answers + 1,
            by_predicate = $2::jsonb,
            updated_at = now()
        WHERE question_id = $1
        """,
        question_id,
        json.dumps(by_predicate),
    )


# ----- override (per-envelope revocation, §1.12) -------------------------


async def delete_one_envelope_and_recompute(
    conn: asyncpg.Connection,
    *,
    question_id: UUID,
    unique_identifier: str,
) -> bool:
    """Atomically delete one envelope and rebuild its question's aggregate.

    Returns True if an envelope was actually deleted, False if none matched
    (idempotent: revoking a non-existent answer is a no-op, not an error).

    Aggregate is rebuilt from the remaining envelopes via ``compute_by_predicate``
    — same path the self-invalidation listener uses (§5 of the broker README) —
    so the post-delete state is provably consistent with what an `increment`
    walk would have produced. The advisory lock serializes us against
    concurrent ``increment_aggregate`` for the same question.
    """
    async with conn.transaction():
        await conn.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
            str(question_id),
        )
        deleted = await conn.fetchval(
            """
            DELETE FROM envelopes
            WHERE question_id = $1 AND unique_identifier = $2
            RETURNING 1
            """,
            question_id,
            unique_identifier,
        )
        if deleted is None:
            return False

        remaining = await conn.fetch(
            """
            SELECT answer, disclosed_predicates
            FROM envelopes
            WHERE question_id = $1
            """,
            question_id,
        )
        envelopes = [dict(r) for r in remaining]
        total = len(envelopes)
        if total == 0:
            await conn.execute(
                "DELETE FROM aggregates WHERE question_id = $1",
                question_id,
            )
            return True

        options_row = await conn.fetchval(
            "SELECT options FROM questions WHERE id = $1",
            question_id,
        )
        options = _normalize_options(options_row)
        by_predicate = compute_by_predicate(envelopes, options)
        await conn.execute(
            """
            INSERT INTO aggregates (question_id, total_answers, by_predicate, updated_at)
            VALUES ($1, $2, $3::jsonb, now())
            ON CONFLICT (question_id) DO UPDATE
            SET total_answers = EXCLUDED.total_answers,
                by_predicate = EXCLUDED.by_predicate,
                updated_at = now()
            """,
            question_id,
            total,
            json.dumps(by_predicate),
        )
        return True


# ----- platform stats ----------------------------------------------------


async def platform_stats(conn: asyncpg.Connection) -> dict[str, Any]:
    """Privacy-safe site-wide counts for the public stats page.

    Only the broker role can read ``registrations`` and ``envelopes`` (the web
    role is revoked from both — see db/init/02-roles.sh), so the broker is the
    single place these aggregates can be computed. We return COUNTs only; no
    nullifiers, agent keys, or per-row data ever leave this boundary.

    ``registered_agents`` counts active (non-revoked) registrations.
    ``respondents`` is the number of distinct verified humans who have answered.
    """
    row = await conn.fetchrow(
        """
        SELECT
          (SELECT COUNT(*) FROM registrations WHERE revoked_at IS NULL) AS registered_agents,
          (SELECT COUNT(*) FROM questions)                              AS questions,
          (SELECT COUNT(*) FROM envelopes)                             AS total_answers,
          (SELECT COUNT(DISTINCT unique_identifier) FROM envelopes)    AS respondents,
          (SELECT COUNT(DISTINCT question_id) FROM envelopes)          AS answered_questions
        """
    )
    return dict(row)
