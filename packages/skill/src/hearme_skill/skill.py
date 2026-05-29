"""Hermes skill entrypoint.

Production answering runs *inside* the user's Hermes agent: the ``hearme``
plugin (``plugin.py``) registers the answering tools and a Hermes cron job
(``schedule.py``) drives the cycle using the host's own configured model — no
second API key. This module provides:

* ``cli()`` — local command-line interface for onboarding + scheduling.
* ``run_loop`` / ``dev_runner`` — a dev-only standalone loop that exercises the
  pipeline with ``FakeLLMClient`` (no Hermes, no network LLM).
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from typing import Any

import httpx

from . import answerer as answerer_mod
from . import persona as persona_mod
from .broker import BrokerClient
from .config import get_settings
from .crypto.keystore import load_or_create_agent_keypair
from .delegation import (
    DelegationError,
    DelegationExpired,
    DelegationMissing,
    load_usable,
)
from .envelope import build_envelope
from .ledger import Ledger
from .llm.client import LLMClient
from .memory.mem0_stub import Mem0StubProvider
from .memory.provider import MemoryProvider
from .models import Question
from .onboarding import (
    OnboardingError,
    accept_delegation_from_mock_phone,
    begin_onboarding,
    complete_onboarding,
    render_qr_ascii,
)
from .policy import LedgerStats, decide, load_policy
from .ui import UI, Channel, InMemoryChannel

log = logging.getLogger("hearme_skill")

# Hearme questions carry an explicit option list (default ['yes','no']). The
# agent must begin its answer with one of the allowed labels so the broker's
# leading-word classifier can tally it; the brief reason after that stays
# local-flavoured but never leaks identity (the Answerer only sees the persona
# projection, never the DelegationToken).
def build_style_guide(options: list[str]) -> str:
    opts = " / ".join(f"'{o}'" for o in options)
    return (
        f"Begin your answer with one of these labels exactly: {opts}, "
        "then add one short sentence of reasoning."
    )


# Back-compat: the default 2-option flow is still yes/no.
YES_NO_STYLE_GUIDE = build_style_guide(["Yes", "No"])


def build_configured_memory(settings) -> MemoryProvider:
    """Build the opt-in standalone memory backend from settings."""

    backend = (settings.memory_backend or "stub").strip().lower()
    if backend in {"chatgpt", "chatgpt-export", "chatgpt_export"}:
        from .memory.chatgpt_export import ChatGPTExportMemoryProvider

        return ChatGPTExportMemoryProvider(settings.chatgpt_memory_path)
    return Mem0StubProvider()


async def answer_one(
    question: Question,
    *,
    memory: MemoryProvider,
    llm: LLMClient,
    ledger: Ledger,
    broker: BrokerClient,
    ui: UI,
    settings,
) -> str:
    """Process a single question end-to-end. Returns the resulting status string."""

    # §1.9 — replay-safe: never re-submit a question we already answered.
    if await ledger.has_submission(question.question_id):
        return "skip-already-submitted"

    policy = load_policy(settings.policy_path)
    stats = LedgerStats(
        answered_today=await ledger.answered_today(),
        has_active_delegation=settings.delegation_path.exists(),
        already_answered_ids=await ledger.already_answered_ids(),
    )

    decision = decide(question, policy, stats)
    if decision.action == "decline":
        return f"decline:{decision.reason}"

    # Delegation must be loadable + unexpired BEFORE we spend an LLM call.
    try:
        token = load_usable(settings.delegation_path)
    except DelegationExpired:
        await ui.announce_expiry()
        return "decline:delegation-expired"
    except DelegationMissing:
        await ui.channel.notify("Hearme: no DelegationToken. Run onboarding.")
        return "decline:delegation-missing"

    await ui.maybe_nudge_for_refresh(token)

    await ledger.record_question(
        question.question_id,
        question.text,
        question.topic,
        question.closes_at,
        question.nonce,
    )

    projection = persona_mod.project(question, memory)
    # Answerer NEVER receives token / unique_identifier (§1.4, §7.4).
    answer = answerer_mod.answer(
        projection, question, llm, style_guide=build_style_guide(question.options)
    )
    await ledger.record_answer(question.question_id, answer.text, answer.rationale)

    if decision.action == "prompt_user" or policy.auto_submit_window_seconds == 0:
        ok = await ui.preview_and_confirm(
            question, answer, auto_submit_window_seconds=policy.auto_submit_window_seconds
        )
        if not ok:
            return "veto"

    agent_kp = load_or_create_agent_keypair(settings.agent_key_path)
    envelope = build_envelope(
        question_id=question.question_id,
        answer_text=answer.text,  # `.rationale` deliberately NOT passed
        nonce=question.nonce,
        delegation_token=token,
        agent_key=agent_kp,
    )

    accepted, reason = await broker.submit_envelope(envelope)
    # Hash hex for the ledger record.
    from .delegation import hash_of

    dhash_hex = hash_of(token).hex()
    await ledger.record_submission(
        question.question_id,
        delegation_hash_hex=dhash_hex,
        agent_signature_b64=envelope.agent_signature,
        accepted=accepted,
        reason=reason or None,
    )
    return "accepted" if accepted else f"rejected:{reason}"


async def run_loop(host: Any) -> None:
    """Steady-state loop. Polls broker, processes new questions one at a time."""

    settings = get_settings()
    settings.root_dir.mkdir(parents=True, exist_ok=True)
    ledger = Ledger(settings.ledger_path)
    await ledger.open()

    channel: Channel = getattr(host, "channel", None) or InMemoryChannel()
    memory: MemoryProvider = getattr(host, "memory", None) or build_configured_memory(settings)
    llm: LLMClient = getattr(host, "llm")  # required from host in production
    ui = UI(channel=channel)

    async with httpx.AsyncClient() as client:
        broker = BrokerClient(
            base_url=settings.broker_url,
            client=client,
            ledger=ledger,
            poll_interval_seconds=settings.poll_interval_seconds,
        )
        try:
            while True:
                questions = await broker.poll_questions()
                for q in questions:
                    try:
                        status = await answer_one(
                            q,
                            memory=memory,
                            llm=llm,
                            ledger=ledger,
                            broker=broker,
                            ui=ui,
                            settings=settings,
                        )
                        log.info("question %s -> %s", q.question_id, status)
                    except DelegationError as exc:
                        log.warning("delegation error: %s", exc)
                    except Exception:  # noqa: BLE001
                        log.exception("question %s failed", q.question_id)
                await asyncio.sleep(settings.poll_interval_seconds)
        finally:
            await ledger.close()


# --- CLI ------------------------------------------------------------------


def _cmd_onboard(args: argparse.Namespace) -> int:
    settings = get_settings()
    settings.root_dir.mkdir(parents=True, exist_ok=True)
    bridge_url = args.bridge_url or settings.self_bridge_url
    broker_url = getattr(args, "broker_url", None) or settings.broker_url
    request = begin_onboarding(
        agent_key_path=settings.agent_key_path,
        bridge_url=bridge_url,
        profile=args.profile,
    )
    print("Scan these QR codes with the Self app (one per age threshold):\n")
    for i, url in enumerate(request.urls, 1):
        print(f"--- proof {i} of {len(request.urls)} ---")
        print(render_qr_ascii(url))
        print(f"Or open: {url}\n")
    if args.no_wait:
        print(f"request_id={request.request_id} (run without --no-wait to store the token)")
        return 0
    print("Waiting for the proofs from your phone, then registering with the broker...")
    try:
        token = complete_onboarding(
            bridge_url=bridge_url,
            broker_url=broker_url,
            request_id=request.request_id,
            agent_public_key=request.agent_public_key,
            delegation_path=settings.delegation_path,
            timeout_seconds=args.timeout,
        )
    except OnboardingError as exc:
        print(f"onboarding failed: {exc}", file=sys.stderr)
        return 2
    print(f"Stored delegation token (expires {token.expires_at.isoformat()})")
    _try_schedule_after_onboard()
    return 0


def _try_schedule_after_onboard() -> None:
    """Best-effort: register the answering cron job once onboarded.

    Only works inside a Hermes environment (the ``cron`` package ships with
    hermes-agent). Outside Hermes we print a hint instead of failing.
    """

    try:
        from .schedule import JOB_NAME, ensure_cron_job
    except Exception:  # noqa: BLE001
        return
    try:
        result = ensure_cron_job()
    except Exception as exc:  # noqa: BLE001
        print(
            "Note: could not register the Hermes cron job "
            f"({exc}). Run `hearme-skill schedule` from inside your Hermes "
            "agent to start the answering cycle.",
            file=sys.stderr,
        )
        return
    verb = "Registered" if result["created"] else "Found existing"
    print(f"{verb} Hermes cron job '{JOB_NAME}' (id={result['job_id']}).")


def _cmd_accept_mock(args: argparse.Namespace) -> int:
    settings = get_settings()
    raw = sys.stdin.read() if args.token_path == "-" else open(args.token_path).read()
    token = accept_delegation_from_mock_phone(
        raw_json=raw, delegation_path=settings.delegation_path
    )
    print(f"Stored delegation token (expires {token.expires_at.isoformat()})")
    return 0


def _cmd_schedule(args: argparse.Namespace) -> int:
    """Install/refresh the Hermes cron job that drives the answering cycle.

    Must run inside a Hermes environment (the ``cron`` package ships with
    hermes-agent). Idempotent — re-running reports the existing job.
    """

    try:
        from .schedule import JOB_NAME, ensure_cron_job
    except Exception as exc:  # noqa: BLE001
        print(f"could not import Hermes cron API: {exc}", file=sys.stderr)
        return 2
    try:
        result = ensure_cron_job(
            schedule=args.schedule, model=args.model, provider=args.provider
        )
    except Exception as exc:  # noqa: BLE001
        print(
            f"could not register cron job (is this running inside Hermes?): {exc}",
            file=sys.stderr,
        )
        return 2
    verb = "created" if result["created"] else "already present"
    print(f"cron job '{JOB_NAME}' {verb} (id={result['job_id']}).")
    return 0


def _cmd_chatgpt_import(args: argparse.Namespace) -> int:
    settings = get_settings()
    settings.root_dir.mkdir(parents=True, exist_ok=True)
    from .memory.chatgpt_export import import_chatgpt_export

    db_path = args.db or settings.chatgpt_memory_path
    try:
        stats = import_chatgpt_export(
            args.export_path,
            db_path=db_path,
            include_assistant=args.include_assistant,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"ChatGPT import failed: {exc}", file=sys.stderr)
        return 2
    print(
        f"Imported {stats.conversations} conversations and {stats.chunks} "
        f"message chunks into {stats.db_path}"
    )
    print("Use HEARME_SKILL_MEMORY_BACKEND=chatgpt-export to answer from this memory DB.")
    return 0


def _cmd_chatgpt_query(args: argparse.Namespace) -> int:
    settings = get_settings()
    from .memory.chatgpt_export import ChatGPTExportMemoryProvider
    from .memory.provider import MemoryQuery

    db_path = args.db or settings.chatgpt_memory_path
    provider = ChatGPTExportMemoryProvider(db_path)
    snapshot = provider.query(MemoryQuery(topic=args.topic, text=args.text, limit=args.limit))
    for fact in snapshot.facts:
        print(f"- {fact}")
    return 0


def cli() -> int:
    parser = argparse.ArgumentParser(prog="hearme-skill")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_onboard = sub.add_parser(
        "onboard",
        help="Generate agent key, print the Self QR codes, register, and store the token",
    )
    p_onboard.add_argument(
        "--bridge-url",
        default=None,
        help="self-bridge URL (default: $HEARME_SKILL_SELF_BRIDGE_URL).",
    )
    p_onboard.add_argument(
        "--broker-url",
        default=None,
        help="broker URL for /v1/register (default: $HEARME_SKILL_BROKER_URL).",
    )
    p_onboard.add_argument("--profile", default="standard")
    p_onboard.add_argument(
        "--timeout",
        type=float,
        default=300.0,
        help="Seconds to wait for the phone to send a proof.",
    )
    p_onboard.add_argument(
        "--no-wait",
        action="store_true",
        help="Print the QR/link and exit without waiting for the proof.",
    )
    p_onboard.set_defaults(func=_cmd_onboard)

    p_accept = sub.add_parser(
        "accept-mock-delegation",
        help="Accept a DelegationToken from scripts/mock-onboard.py (dev fixture replay)",
    )
    p_accept.add_argument("token_path", help="Path to token JSON, or '-' for stdin")
    p_accept.set_defaults(func=_cmd_accept_mock)

    p_sched = sub.add_parser(
        "schedule",
        help="Install/refresh the Hermes cron job that answers questions on a schedule",
    )
    p_sched.add_argument(
        "--schedule",
        default=None,
        help="Cron cadence: 'every 15m', a cron expression, or an ISO time (default: every 15m).",
    )
    p_sched.add_argument(
        "--model",
        default=None,
        help="Override the model for this job (default: the Hermes agent's configured model).",
    )
    p_sched.add_argument(
        "--provider",
        default=None,
        help="Override the provider for this job (default: the Hermes agent's configured provider).",
    )
    p_sched.set_defaults(func=_cmd_schedule)

    p_cg_import = sub.add_parser(
        "chatgpt-import",
        help="Import a downloaded ChatGPT export into Hearme's local memory DB",
    )
    p_cg_import.add_argument(
        "export_path",
        help="Path to ChatGPT export ZIP, extracted directory, or conversations.json",
    )
    p_cg_import.add_argument(
        "--db",
        default=None,
        help="Destination SQLite DB (default: ~/.hermes/hearme/chatgpt_memory.sqlite).",
    )
    p_cg_import.add_argument(
        "--include-assistant",
        action="store_true",
        help="Also index assistant replies. Default indexes only user-authored messages.",
    )
    p_cg_import.set_defaults(func=_cmd_chatgpt_import)

    p_cg_query = sub.add_parser(
        "chatgpt-query",
        help="Query the imported ChatGPT memory DB",
    )
    p_cg_query.add_argument("text")
    p_cg_query.add_argument("--topic", default=None)
    p_cg_query.add_argument("--limit", type=int, default=5)
    p_cg_query.add_argument(
        "--db",
        default=None,
        help="SQLite DB (default: ~/.hermes/hearme/chatgpt_memory.sqlite).",
    )
    p_cg_query.set_defaults(func=_cmd_chatgpt_query)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(cli())
