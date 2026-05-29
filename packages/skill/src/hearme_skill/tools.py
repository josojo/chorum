"""Framework-agnostic answering tools — the reusable core.

These are plain **synchronous** functions with NO agent-framework imports, so
the same core backs the Hermes plugin today (``plugin.py``) and can back
adapters for other agent frameworks later. Each function returns a
JSON-friendly ``dict`` and never raises into the caller — failures come back as
structured results the agent can read.

Two tools, mirroring the linear pipeline in ARCHITECTURE.md §7 but driven by an
external agent instead of an in-process loop:

* :func:`list_open_questions` — fetch open questions, return only the ones the
  user's policy permits to be auto-answered. The agent composes answers from
  its own memory of the user.
* :func:`submit_answer` — sign + submit one answer the agent decided on.

Privacy invariants are enforced HERE (the tool boundary), never in a prompt:

* The DelegationToken and ``unique_identifier`` never leave this module. The
  model only ever sees ``question_id`` / ``text`` / ``topic`` from
  :func:`list_open_questions`, and passes back ``question_id`` + ``answer`` to
  :func:`submit_answer`. The ``nonce`` and all signing material stay local.
* The policy gate (topic allow/blocklist, daily cap, replay-safety, delegation
  validity) is re-checked on EVERY submit, so the agent cannot exceed it no
  matter what it decides. Unattended auto-submit is opt-in: a question is only
  surfaced/accepted when ``decide()`` returns ``"answer"``, which requires
  ``auto_answer: true`` in ``policy.yaml`` (§1.12 — override is sacred).
"""

from __future__ import annotations

import asyncio
import logging

import httpx

from .broker import BrokerClient
from .config import Settings, get_settings
from .crypto.keystore import load_or_create_agent_keypair
from .delegation import DelegationExpired, DelegationMissing, hash_of, load_usable
from .envelope import build_envelope
from .ledger import Ledger
from .models import Question
from .policy import LedgerStats, decide, load_policy

log = logging.getLogger("hearme_skill.tools")


async def _fetch_open_questions(
    client: httpx.AsyncClient, base_url: str
) -> list[Question]:
    """GET /v1/questions/open with NO cursor.

    Unlike the in-process loop's ``BrokerClient.poll_questions`` (which advances
    a ``last_seen`` cursor), the agentic tools want *every* currently-open
    question each cycle — a question the agent skips or that fails to land must
    reappear next run. Idempotency comes from the ledger (``has_submission`` /
    ``already_answered_ids``), not from a cursor.
    """

    resp = await client.get(f"{base_url}/v1/questions/open", timeout=15.0)
    resp.raise_for_status()
    return [Question.model_validate(q) for q in resp.json()]


async def _list_impl(settings: Settings, *, transport: httpx.AsyncBaseTransport | None) -> dict:
    ledger = Ledger(settings.ledger_path)
    await ledger.open()
    try:
        policy = load_policy(settings.policy_path)
        stats = LedgerStats(
            answered_today=await ledger.answered_today(),
            has_active_delegation=settings.delegation_path.exists(),
            already_answered_ids=await ledger.already_answered_ids(),
        )
        async with httpx.AsyncClient(transport=transport) as client:
            questions = await _fetch_open_questions(client, settings.broker_url)

        answerable: list[dict] = []
        skipped = 0
        for q in questions:
            if decide(q, policy, stats).action == "answer":
                # Deliberately omit the nonce: it is signing material and never
                # needs to enter the agent's (LLM) context.
                answerable.append(
                    {
                        "question_id": q.question_id,
                        "text": q.text,
                        "topic": q.topic,
                        "options": list(q.options),
                        "closes_at": q.closes_at.isoformat(),
                    }
                )
            else:
                skipped += 1
        return {"questions": answerable, "skipped_count": skipped}
    finally:
        await ledger.close()


async def _submit_impl(
    question_id: str,
    answer_text: str,
    settings: Settings,
    *,
    transport: httpx.AsyncBaseTransport | None,
) -> dict:
    answer_text = (answer_text or "").strip()
    if not answer_text:
        return {"accepted": False, "reason": "empty-answer", "question_id": question_id}

    ledger = Ledger(settings.ledger_path)
    await ledger.open()
    try:
        # §1.9 replay-safety: never re-submit an accepted answer.
        if await ledger.has_submission(question_id):
            return {"accepted": False, "reason": "already-submitted", "question_id": question_id}

        # Delegation must be loadable + unexpired BEFORE we sign anything.
        try:
            token = load_usable(settings.delegation_path)
        except DelegationMissing:
            return {"accepted": False, "reason": "no-delegation", "question_id": question_id}
        except DelegationExpired:
            return {"accepted": False, "reason": "delegation-expired", "question_id": question_id}

        async with httpx.AsyncClient(transport=transport) as client:
            # Re-fetch so we read the authoritative nonce and confirm the
            # question is still open right now (avoids submitting to a closed
            # question, and keeps the nonce out of the agent's context).
            questions = await _fetch_open_questions(client, settings.broker_url)
            question = next((q for q in questions if q.question_id == question_id), None)
            if question is None:
                return {"accepted": False, "reason": "question-not-open", "question_id": question_id}

            # Hard policy backstop, re-evaluated at submit time.
            policy = load_policy(settings.policy_path)
            stats = LedgerStats(
                answered_today=await ledger.answered_today(),
                has_active_delegation=True,
                already_answered_ids=await ledger.already_answered_ids(),
            )
            decision = decide(question, policy, stats)
            if decision.action != "answer":
                return {
                    "accepted": False,
                    "reason": f"policy-declined:{decision.reason}",
                    "question_id": question_id,
                }

            await ledger.record_question(
                question.question_id,
                question.text,
                question.topic,
                question.closes_at,
                question.nonce,
            )
            agent_kp = load_or_create_agent_keypair(settings.agent_key_path)
            envelope = build_envelope(
                question_id=question.question_id,
                answer_text=answer_text,
                nonce=question.nonce,
                delegation_token=token,
                agent_key=agent_kp,
            )
            broker = BrokerClient(base_url=settings.broker_url, client=client, ledger=ledger)
            accepted, reason = await broker.submit_envelope(envelope)

        # rationale stays empty — the agent's reasoning never enters the ledger
        # or the wire (it lived only in the host model's context).
        await ledger.record_answer(question_id, answer_text, "")
        await ledger.record_submission(
            question_id,
            delegation_hash_hex=hash_of(token).hex(),
            agent_signature_b64=envelope.agent_signature,
            accepted=accepted,
            reason=reason or None,
        )
        return {
            "accepted": accepted,
            "reason": reason or ("ok" if accepted else "rejected"),
            "question_id": question_id,
        }
    finally:
        await ledger.close()


# --- public, framework-agnostic API --------------------------------------


def list_open_questions(
    *,
    settings: Settings | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict:
    """Return open questions the user's policy permits answering.

    Shape: ``{"questions": [{"question_id", "text", "topic", "closes_at"}...],
    "skipped_count": int}``. Safe to call from any non-async context (it owns
    its event loop); never raises — broker/ledger errors come back as
    ``{"error": "..."}``.
    """

    settings = settings or get_settings()
    try:
        return asyncio.run(_list_impl(settings, transport=transport))
    except Exception as exc:  # noqa: BLE001
        log.exception("list_open_questions failed")
        return {"error": str(exc), "questions": [], "skipped_count": 0}


def submit_answer(
    question_id: str,
    answer_text: str,
    *,
    settings: Settings | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict:
    """Sign + submit one answer the agent decided on.

    Shape: ``{"accepted": bool, "reason": str, "question_id": str}``. Enforces
    the full policy/replay/delegation backstop; never raises.
    """

    settings = settings or get_settings()
    try:
        return asyncio.run(_submit_impl(question_id, answer_text, settings, transport=transport))
    except Exception as exc:  # noqa: BLE001
        log.exception("submit_answer failed")
        return {"accepted": False, "reason": str(exc), "question_id": question_id}
