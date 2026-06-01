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
import json
import logging
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import httpx

from . import answerer as answerer_mod
from . import hermes_shim
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
    # Persist the broker/bridge URLs the user actually onboarded against, so the
    # Hermes cron job (which starts in a fresh process and doesn't inherit this
    # shell's env) hits the same broker instead of falling back to localhost.
    # Only writes when the URL was explicitly non-default — see _persist_broker_urls.
    try:
        defaults = get_settings().__class__()  # fresh defaults, ignoring current env
        result = _persist_broker_urls(
            broker_url=broker_url,
            bridge_url=bridge_url,
            broker_default=defaults.broker_url,
            bridge_default=defaults.self_bridge_url,
        )
    except Exception as exc:  # noqa: BLE001
        print(
            f"Note: could not persist broker URLs to ~/.hermes/.env ({exc}). "
            "Set HEARME_SKILL_BROKER_URL / HEARME_SKILL_SELF_BRIDGE_URL there "
            "by hand so the cron job inherits them.",
            file=sys.stderr,
        )
    else:
        if result is not None:
            path, written = result
            keys = ", ".join(sorted(written))
            print(f"Persisted {keys} to {path}.")
    _post_onboard_setup(
        host=getattr(args, "host", "auto"),
        broker_url=broker_url,
        bridge_url=bridge_url,
    )
    return 0


def _resolve_hosts(host: str) -> list[str]:
    """Which agent host(s) to wire up after onboarding.

    ``auto`` (default) detects installed hosts: Hermes if ``~/.hermes`` exists,
    OpenClaw if its CLI/dir is present (both if both). Falls back to Hermes when
    neither is detected, preserving the original behaviour. Explicit values:
    ``hermes``, ``openclaw``, or ``both``.
    """

    host = (host or "auto").lower()
    if host == "both":
        return ["hermes", "openclaw"]
    if host in {"hermes", "openclaw"}:
        return [host]

    from . import openclaw as _oc

    hosts: list[str] = []
    if (Path.home() / ".hermes").exists():
        hosts.append("hermes")
    if _oc.openclaw_available():
        hosts.append("openclaw")
    return hosts or ["hermes"]


def _post_onboard_setup(
    *, host: str, broker_url: str | None, bridge_url: str | None
) -> None:
    """Wire up the detected/selected agent host(s) after identity onboarding."""

    hosts = _resolve_hosts(host)
    if "hermes" in hosts:
        _try_install_plugin_after_onboard()
        _try_schedule_after_onboard()
    if "openclaw" in hosts:
        _try_install_openclaw_after_onboard(broker_url=broker_url, bridge_url=bridge_url)


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


# --- Hermes plugin self-install --------------------------------------------
#
# Hermes' built-in plugin installers don't fit our shape:
#
# * `hermes plugins install owner/repo` clones the repo root and expects
#   plugin.yaml there — but ours lives in `packages/skill/`, so the loader
#   silently no-ops (the directory exists but registers no tools).
# * The `hermes_agent.plugins` entry point we advertise in `pyproject.toml`
#   IS discovered, but discovery is lazy in some Hermes versions and may not
#   fire at gateway boot. We don't want users guessing.
#
# Deterministic path: drop a 2-file directory under `~/.hermes/plugins/hearme/`
# (manifest + tiny shim that re-exports `register`), restart the gateway, done.
# `install-plugin` does exactly that. `onboard` also calls it automatically so
# the end-user steps collapse to:
#
#   pip install 'git+https://github.com/josojo/hearme.git#subdirectory=packages/skill'
#   hearme-skill onboard --bridge-url ... --broker-url ...

_PLUGIN_DIRNAME = "hearme"
# Shim written into ~/.hermes/plugins/hearme/__init__.py when hearme_skill is
# pip-installed in the gateway venv. Binary installs use the subprocess shim
# instead (see install_plugin_dir + hermes_shim.build_subprocess_shim).
_PLUGIN_SHIM = hermes_shim.IMPORT_SHIM

# Embedded manifest. Kept in sync by hand with `packages/skill/plugin.yaml` —
# they're both ~20 lines and rarely change. The tool names below mirror the
# `register_tool` calls in `plugin.py`; if they drift, `plugin.yaml` is the
# canonical reference and tests/test_tools.py will catch the schema break.
_PLUGIN_MANIFEST = """\
name: hearme
version: 0.0.1
description: >-
  Answer public yes/no questions on the user's behalf, using the host agent's
  own model and memory. Inference needs no extra API key; a cron job drives the
  answering cycle.
author: Hearme
kind: standalone
provides_tools:
  - hearme_list_open_questions
  - hearme_submit_answer
"""


def _plugin_dir() -> Path:
    """Where Hermes scans for directory-installed plugins."""

    return Path.home() / ".hermes" / "plugins" / _PLUGIN_DIRNAME


def _hermes_env_path() -> Path:
    """The env file the Hermes gateway/cron load on startup.

    Same file the gateway tells you to edit in its `GATEWAY_ALLOW_ALL_USERS`
    warning; we treat it as the canonical place for `HEARME_SKILL_*` overrides.
    """

    return Path.home() / ".hermes" / ".env"


def upsert_hermes_env(
    updates: dict[str, str], *, env_path: Path | None = None
) -> Path:
    """Idempotent upsert of ``KEY=value`` lines in ``~/.hermes/.env``.

    For each ``(key, value)`` in ``updates``, replaces the existing line that
    starts with ``KEY=`` (or ``export KEY=``) and otherwise appends it. Comments,
    blank lines, and unrelated keys are preserved byte-for-byte. Creates the
    parent directory and the file if either is missing.

    Returns the path written. Caller decides what to log — this function is
    silent so it can be reused from onboarding and install-plugin without
    duplicating the message.
    """

    target = env_path or _hermes_env_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    existing = target.read_text() if target.exists() else ""
    # Preserve a trailing newline policy: if the file is non-empty and lacks
    # a final newline, the replaced-or-appended block re-establishes one.
    lines = existing.splitlines()
    remaining = dict(updates)
    out: list[str] = []
    for line in lines:
        stripped = line.lstrip()
        # Match `KEY=...` or `export KEY=...`; ignore comments.
        if stripped.startswith("#") or "=" not in stripped:
            out.append(line)
            continue
        head = stripped
        if head.startswith("export "):
            head = head[len("export ") :].lstrip()
        key = head.split("=", 1)[0].strip()
        if key in remaining:
            out.append(f"{key}={remaining.pop(key)}")
        else:
            out.append(line)
    for key, value in remaining.items():
        out.append(f"{key}={value}")
    target.write_text("\n".join(out) + ("\n" if out else ""))
    return target


def _persist_broker_urls(
    *,
    broker_url: str | None,
    bridge_url: str | None,
    broker_default: str,
    bridge_default: str,
    env_path: Path | None = None,
) -> tuple[Path, dict[str, str]] | None:
    """Persist any explicitly-provided URLs to an env file (``~/.hermes/.env``
    by default; pass ``env_path`` for the OpenClaw ``~/.openclaw/.env``).

    "Explicit" means the value differs from the localhost-default config
    fallback — we don't want `hearme-skill onboard` on a dev box to write
    `HEARME_SKILL_BROKER_URL=http://localhost:8000` when the user never asked
    for that. Returns ``(env_path, written)`` if anything was written, else
    ``None``.
    """

    updates: dict[str, str] = {}
    if broker_url and broker_url != broker_default:
        updates["HEARME_SKILL_BROKER_URL"] = broker_url
    if bridge_url and bridge_url != bridge_default:
        updates["HEARME_SKILL_SELF_BRIDGE_URL"] = bridge_url
    if not updates:
        return None
    path = upsert_hermes_env(updates, env_path=env_path)
    return path, updates


def install_plugin_dir(
    *, plugin_dir: Path | None = None, binary_path: str | None = None
) -> Path:
    """Write the Hermes directory-install drop-in. Idempotent.

    Returns the directory written. Always overwrites the two files so a stale
    half-cloned install (e.g. from a failed `hermes plugins install`) is
    cleanly replaced.

    Shim selection:

    * **Binary mode** — when running as the frozen ``hearme-skill`` executable
      (``sys.frozen``) or when ``binary_path`` is passed explicitly, the shim
      shells out to that binary so the gateway needs no pip-installed
      ``hearme_skill`` package.
    * **Pip mode** — otherwise the shim re-exports ``register`` from the
      installed ``hearme_skill`` package.
    """

    target = plugin_dir or _plugin_dir()
    target.mkdir(parents=True, exist_ok=True)
    (target / "plugin.yaml").write_text(_PLUGIN_MANIFEST)

    resolved_bin = binary_path
    if resolved_bin is None and getattr(sys, "frozen", False):
        resolved_bin = sys.executable
    if resolved_bin:
        shim = hermes_shim.build_subprocess_shim(resolved_bin)
    else:
        shim = _PLUGIN_SHIM
    (target / "__init__.py").write_text(shim)
    return target


def _restart_gateway() -> tuple[bool, str]:
    """Best-effort `systemctl --user restart hermes-gateway`.

    Returns (success, message). Failure is non-fatal — the user can restart by
    hand — but we surface a clear hint so they know what's needed.
    """

    systemctl = shutil.which("systemctl")
    if not systemctl:
        return False, "systemctl not found (not a systemd host?)"
    try:
        subprocess.run(
            [systemctl, "--user", "restart", "hermes-gateway"],
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
        return True, "restarted hermes-gateway"
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or exc.stdout or "").strip() or f"exit {exc.returncode}"
        return False, f"systemctl restart failed: {detail}"
    except subprocess.TimeoutExpired:
        return False, "systemctl restart timed out after 30s"


def _cmd_install_plugin(args: argparse.Namespace) -> int:
    target = install_plugin_dir()
    print(f"Wrote Hermes plugin drop-in to {target}")
    # Same persistence as _cmd_onboard: useful when a user already onboarded
    # against a remote broker but is hitting connect errors from the cron job
    # because no env was ever written. `hearme-skill install-plugin
    # --broker-url ... --bridge-url ...` is the recovery command.
    broker_url = getattr(args, "broker_url", None)
    bridge_url = getattr(args, "bridge_url", None)
    if broker_url or bridge_url:
        try:
            defaults = get_settings().__class__()
            result = _persist_broker_urls(
                broker_url=broker_url,
                bridge_url=bridge_url,
                broker_default=defaults.broker_url,
                bridge_default=defaults.self_bridge_url,
            )
        except Exception as exc:  # noqa: BLE001
            print(
                f"Could not persist broker URLs to ~/.hermes/.env ({exc}).",
                file=sys.stderr,
            )
        else:
            if result is not None:
                path, written = result
                keys = ", ".join(sorted(written))
                print(f"Persisted {keys} to {path}.")
    if args.no_restart:
        print("Restart the Hermes gateway to load the plugin:")
        print("  systemctl --user restart hermes-gateway")
        return 0
    ok, msg = _restart_gateway()
    if ok:
        print(msg.capitalize() + ".")
    else:
        print(
            f"Could not auto-restart the gateway ({msg}). Restart it manually:\n"
            "  systemctl --user restart hermes-gateway",
            file=sys.stderr,
        )
    return 0


def _try_install_plugin_after_onboard() -> None:
    """Best-effort: drop in the plugin directory + restart the gateway.

    Called from `_cmd_onboard` so the canonical user flow is just one pip
    command + one `hearme-skill onboard ...`. Failures print a hint but never
    break onboarding — the user can run `hearme-skill install-plugin` later.
    """

    try:
        target = install_plugin_dir()
    except Exception as exc:  # noqa: BLE001
        print(
            f"Note: could not write the Hermes plugin drop-in ({exc}). "
            "Run `hearme-skill install-plugin` to retry.",
            file=sys.stderr,
        )
        return
    print(f"Installed Hermes plugin drop-in at {target}.")
    ok, msg = _restart_gateway()
    if ok:
        print("Restarted hermes-gateway; the hearme tools are now loaded.")
    else:
        print(
            f"Plugin written, but the gateway was not restarted ({msg}). "
            "Restart it to load the tools:\n"
            "  systemctl --user restart hermes-gateway",
            file=sys.stderr,
        )


# --- OpenClaw skill install ------------------------------------------------
#
# OpenClaw (openclaw.ai) is a second host for the SAME hearme core. Its
# extension unit is a SKILL.md directory whose instructions tell the host agent
# to run our CLI via the built-in `exec` tool — so the OpenClaw adapter is just
# "drop the skill dir + register a cron job", mirroring install-plugin +
# schedule on the Hermes side. All the real work stays in tools.py. See
# openclaw.py.


def _report_openclaw_cron(result: dict) -> None:
    """Print the outcome of :func:`openclaw.ensure_openclaw_cron`."""

    from . import openclaw

    if result.get("created"):
        print(f"Registered OpenClaw cron job '{result.get('name')}'.")
    elif result.get("reason") == "already present":
        print(f"OpenClaw cron job '{result.get('name')}' already present.")
    else:
        print(
            "Note: could not register the OpenClaw cron job "
            f"({result.get('reason')}). Register it by hand once OpenClaw is "
            "running:\n"
            f"  openclaw cron add --name {openclaw.CRON_NAME} "
            f'--cron "{openclaw.DEFAULT_SCHEDULE}" --session isolated '
            f'--message "{openclaw.CRON_MESSAGE}"',
            file=sys.stderr,
        )


def _cmd_install_openclaw(args: argparse.Namespace) -> int:
    from . import openclaw

    target = openclaw.install_openclaw_skill()
    print(f"Wrote OpenClaw skill to {target / 'SKILL.md'}")

    broker_url = getattr(args, "broker_url", None)
    bridge_url = getattr(args, "bridge_url", None)
    if broker_url or bridge_url:
        try:
            defaults = get_settings().__class__()
            result = _persist_broker_urls(
                broker_url=broker_url,
                bridge_url=bridge_url,
                broker_default=defaults.broker_url,
                bridge_default=defaults.self_bridge_url,
                env_path=openclaw.openclaw_env_path(),
            )
        except Exception as exc:  # noqa: BLE001
            print(
                f"Could not persist broker URLs to {openclaw.openclaw_env_path()} ({exc}).",
                file=sys.stderr,
            )
        else:
            if result is not None:
                path, written = result
                keys = ", ".join(sorted(written))
                print(f"Persisted {keys} to {path}.")

    if not args.no_cron:
        _report_openclaw_cron(openclaw.ensure_openclaw_cron(schedule=args.schedule))

    print(
        "OpenClaw snapshots skills at session start — start a new session (or "
        "run `openclaw gateway restart`) to pick up hearme."
    )
    return 0


def _try_install_openclaw_after_onboard(
    *, broker_url: str | None, bridge_url: str | None
) -> None:
    """Best-effort: drop in the OpenClaw skill + cron after onboarding.

    The OpenClaw analog of ``_try_install_plugin_after_onboard`` +
    ``_try_schedule_after_onboard``. Failures print a hint but never break
    onboarding — the user can run ``hearme-skill install-openclaw`` later.
    """

    from . import openclaw

    try:
        target = openclaw.install_openclaw_skill()
    except Exception as exc:  # noqa: BLE001
        print(
            f"Note: could not write the OpenClaw skill ({exc}). "
            "Run `hearme-skill install-openclaw` to retry.",
            file=sys.stderr,
        )
        return
    print(f"Installed OpenClaw skill at {target / 'SKILL.md'}.")
    # Persist non-default broker/bridge URLs so the scheduled OpenClaw run (a
    # fresh process) hits the same broker.
    try:
        defaults = get_settings().__class__()
        result = _persist_broker_urls(
            broker_url=broker_url,
            bridge_url=bridge_url,
            broker_default=defaults.broker_url,
            bridge_default=defaults.self_bridge_url,
            env_path=openclaw.openclaw_env_path(),
        )
    except Exception:  # noqa: BLE001
        result = None
    if result is not None:
        path, written = result
        print(f"Persisted {', '.join(sorted(written))} to {path}.")
    _report_openclaw_cron(openclaw.ensure_openclaw_cron())


# --- unified host-aware install --------------------------------------------
#
# One command that wires up whichever agent host(s) are present, so the binary
# flow collapses to: download the binary (install.sh) -> `hearme-skill install`
# -> `hearme-skill onboard`. Reuses the per-host installers above.


def _cmd_install(args: argparse.Namespace) -> int:
    hosts = _resolve_hosts(args.host)
    done: list[str] = []

    if "hermes" in hosts:
        target = install_plugin_dir()
        print(f"Installed Hermes plugin drop-in at {target}.")
        if not args.no_restart:
            ok, msg = _restart_gateway()
            if ok:
                print("Restarted hermes-gateway.")
            else:
                print(
                    f"Could not auto-restart the gateway ({msg}). Restart it manually:\n"
                    "  systemctl --user restart hermes-gateway",
                    file=sys.stderr,
                )
        done.append("hermes")

    if "openclaw" in hosts:
        from . import openclaw

        target = openclaw.install_openclaw_skill()
        print(f"Installed OpenClaw skill at {target / 'SKILL.md'}.")
        if not args.no_cron:
            _report_openclaw_cron(openclaw.ensure_openclaw_cron(schedule=args.schedule))
        done.append("openclaw")

    if not done:
        print(
            "No supported agent detected (looked for ~/.hermes and OpenClaw on "
            "PATH / ~/.openclaw). Re-run with --host hermes|openclaw|both.",
            file=sys.stderr,
        )
        return 1

    print(
        "Next: run `hearme-skill onboard --broker-url <url> --bridge-url <url>` "
        "once to set up your Self identity."
    )
    return 0


# --- answering CLI (shared core; the OpenClaw skill calls these via `exec`) --
#
# Thin wrappers over the framework-agnostic functions in tools.py — the SAME
# core the Hermes plugin tools call. They print JSON to stdout so the OpenClaw
# agent can parse the result, and are handy for debugging the Hermes path too.


def _settings_for(broker_url: str | None):
    settings = get_settings()
    if broker_url:
        settings = settings.model_copy(update={"broker_url": broker_url})
    return settings


def _cmd_list_questions(args: argparse.Namespace) -> int:
    from .tools import list_open_questions

    print(json.dumps(list_open_questions(settings=_settings_for(args.broker_url))))
    return 0


def _cmd_submit_answer(args: argparse.Namespace) -> int:
    from .tools import submit_answer

    result = submit_answer(
        args.question_id, args.answer, settings=_settings_for(args.broker_url)
    )
    print(json.dumps(result))
    return 0 if result.get("accepted") else 1


def _cmd_review_answers(args: argparse.Namespace) -> int:
    from .tools import review_my_answers

    print(json.dumps(review_my_answers(limit=args.limit, settings=_settings_for(None))))
    return 0


def _cmd_revoke_answer(args: argparse.Namespace) -> int:
    from .tools import revoke_answer

    result = revoke_answer(args.question_id, settings=_settings_for(args.broker_url))
    print(json.dumps(result))
    return 0 if result.get("accepted") else 1


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
    p_onboard.add_argument(
        "--host",
        choices=["auto", "hermes", "openclaw", "both"],
        default="auto",
        help=(
            "Which agent host to wire up after onboarding (install the skill +"
            " register the answering cron job). 'auto' detects what's installed."
        ),
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

    p_install = sub.add_parser(
        "install-plugin",
        help=(
            "Drop the Hermes plugin manifest + shim under ~/.hermes/plugins/hearme/"
            " and restart the gateway. Run this once after `pip install hearme-skill`."
        ),
    )
    p_install.add_argument(
        "--no-restart",
        action="store_true",
        help="Skip the `systemctl --user restart hermes-gateway` step.",
    )
    p_install.add_argument(
        "--broker-url",
        default=None,
        help=(
            "Persist HEARME_SKILL_BROKER_URL=<url> in ~/.hermes/.env so the"
            " Hermes cron job inherits it. Use when you already onboarded but"
            " the cron job fails with 'All connection attempts failed'."
        ),
    )
    p_install.add_argument(
        "--bridge-url",
        default=None,
        help="Persist HEARME_SKILL_SELF_BRIDGE_URL=<url> in ~/.hermes/.env.",
    )
    p_install.set_defaults(func=_cmd_install_plugin)

    p_inst = sub.add_parser(
        "install",
        help=(
            "Detect the agent host(s) and install the hearme skill/plugin for each."
            " The one-step companion to the prebuilt-binary install (install.sh)."
        ),
    )
    p_inst.add_argument(
        "--host",
        choices=["auto", "hermes", "openclaw", "both"],
        default="auto",
        help="Which host(s) to install for (default: auto-detect).",
    )
    p_inst.add_argument(
        "--no-restart",
        action="store_true",
        help="Skip restarting the Hermes gateway.",
    )
    p_inst.add_argument(
        "--no-cron",
        action="store_true",
        help="Skip registering the OpenClaw cron job.",
    )
    p_inst.add_argument(
        "--schedule",
        default=None,
        help="Cron expression for the OpenClaw answering cycle (default: 0 9 * * *).",
    )
    p_inst.set_defaults(func=_cmd_install)

    p_oc = sub.add_parser(
        "install-openclaw",
        help=(
            "Drop the OpenClaw skill under ~/.openclaw/skills/hearme/ and register"
            " the answering cron job. Run once after `pip install hearme-skill`."
        ),
    )
    p_oc.add_argument(
        "--no-cron",
        action="store_true",
        help="Skip registering the OpenClaw cron job (write the skill only).",
    )
    p_oc.add_argument(
        "--schedule",
        default=None,
        help="Cron expression for the answering cycle (default: 0 9 * * *).",
    )
    p_oc.add_argument(
        "--broker-url",
        default=None,
        help="Persist HEARME_SKILL_BROKER_URL=<url> in ~/.openclaw/.env.",
    )
    p_oc.add_argument(
        "--bridge-url",
        default=None,
        help="Persist HEARME_SKILL_SELF_BRIDGE_URL=<url> in ~/.openclaw/.env.",
    )
    p_oc.set_defaults(func=_cmd_install_openclaw)

    p_list_q = sub.add_parser(
        "list-questions",
        help="Print (as JSON) the open questions the policy permits answering.",
    )
    p_list_q.add_argument(
        "--broker-url",
        default=None,
        help="Override the broker URL (default: $HEARME_SKILL_BROKER_URL).",
    )
    p_list_q.set_defaults(func=_cmd_list_questions)

    p_submit = sub.add_parser(
        "submit-answer",
        help="Sign + submit one answer on the user's behalf; prints JSON.",
    )
    p_submit.add_argument("--question-id", required=True, help="The question_id to answer.")
    p_submit.add_argument(
        "--answer",
        required=True,
        help="Answer text: start with one of the question's options exactly, then one sentence.",
    )
    p_submit.add_argument("--broker-url", default=None, help="Override the broker URL.")
    p_submit.set_defaults(func=_cmd_submit_answer)

    p_review = sub.add_parser(
        "review-answers",
        help="Print (as JSON) the user's own recently submitted answers (local read).",
    )
    p_review.add_argument("--limit", type=int, default=20, help="Max answers to list.")
    p_review.set_defaults(func=_cmd_review_answers)

    p_revoke = sub.add_parser(
        "revoke-answer",
        help="Retract one of the user's previously-submitted answers; prints JSON.",
    )
    p_revoke.add_argument("--question-id", required=True, help="The question_id to revoke.")
    p_revoke.add_argument("--broker-url", default=None, help="Override the broker URL.")
    p_revoke.set_defaults(func=_cmd_revoke_answer)

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
