"""OpenClaw skill adapter — install + cron registration.

OpenClaw (https://openclaw.ai, github.com/openclaw/openclaw) is a self-hosted
personal-agent runtime whose extension unit is a **skill**: a directory holding
a ``SKILL.md`` (YAML frontmatter + markdown instructions). A skill does not
register typed tools; instead its instructions tell the host agent *when and
how* to use OpenClaw's built-in ``exec`` tool to run shell commands. We lean on
that directly: the SKILL.md teaches the agent to call our ``hearme-skill`` CLI,
which is a thin shell over the SAME framework-agnostic core (``tools.py``) that
backs the Hermes plugin (``plugin.py``).

So the *only* OpenClaw-specific code is in this module:

* :data:`SKILL_MD` — the SKILL.md the agent reads (mirrors the Hermes
  ``ANSWER_PROMPT`` behavioural contract, but phrased around the CLI).
* :func:`install_openclaw_skill` — drop the skill dir under
  ``~/.openclaw/skills/hearme/`` (the global, all-agents location).
* :func:`ensure_openclaw_cron` — register the recurring answering run with
  OpenClaw's own scheduler (the analog of ``schedule.py``'s Hermes cron job).

Everything below the CLI — identity, policy gate, envelope signing, the ledger,
fetching open questions — is shared with Hermes and is NOT duplicated here.

Spec notes / assumptions (OpenClaw docs, verified against docs.openclaw.ai +
github.com/openclaw/openclaw as of 2026-05; flagged because the surface moves):

* SKILL.md frontmatter ``metadata`` is parsed as a single-line JSON object, so
  the gating block is kept on one line.
* The cron CLI shape used is ``openclaw cron add --name <n> --cron <expr>
  --session isolated --message <m>`` with ``openclaw cron list`` for the
  idempotency check. If your OpenClaw build differs, ``ensure_openclaw_cron``
  fails closed (best-effort) and prints a hint — register the job by hand.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
from pathlib import Path

log = logging.getLogger("hearme_skill.openclaw")

SKILL_NAME = "hearme"
CRON_NAME = "hearme-answer-cycle"
# Same cadence rationale as schedule.py:DEFAULT_SCHEDULE — daily keeps host-model
# cost predictable; questions close on a day scale. Override with --schedule.
DEFAULT_SCHEDULE = "0 9 * * *"
# The message OpenClaw's scheduler sends each cycle. Short on purpose: the
# SKILL.md instructions carry the actual behavioural contract; this just trips
# the skill.
CRON_MESSAGE = (
    "Answer any open Hearme questions on my behalf using the hearme skill, "
    "then stop."
)

# Canonical SKILL.md. This string is the single source of truth; the committed
# copy at packages/skill/openclaw/hearme/SKILL.md is asserted byte-identical by
# tests/test_openclaw.py so `openclaw skills install ./...` and the embedded
# installer can never drift. Keep the behavioural rules in step with
# schedule.py:ANSWER_PROMPT (the Hermes equivalent).
SKILL_MD = """\
---
name: hearme
description: Answer public Hearme questions on the user's behalf in their voice, fetching open questions and submitting signed answers via the hearme-skill CLI.
metadata: {"openclaw": {"requires": {"bins": ["hearme-skill"]}}}
---

# Hearme — answer questions on the user's behalf

Hearme lets your user's verified agent (you) answer public multiple-choice
questions in their voice. All identity, policy, privacy, and signing logic lives
in the `hearme-skill` CLI — you only decide the user's honest answer and run the
commands below with the `exec` tool. The question's signing nonce and the user's
identity never enter your context.

## When to use

Use this skill when the user asks you to "answer my Hearme questions", "check
Hearme", or on a scheduled Hearme answering run.

## How to answer

1. List the open questions the user's policy allows you to answer:

   ```bash
   hearme-skill list-questions
   ```

   It prints JSON: `{"questions": [{"question_id", "text", "topic", "options",
   "closes_at"}], "skipped_count"}`. Each question's `options` array is the only
   set of valid answers (e.g. `["yes","no"]` or `["pizza","pasta","sushi"]`).

2. For each question, decide your user's honest answer based ONLY on what you
   actually know about them from your memory and past conversations. If you do
   not genuinely know how they would answer, SKIP it — never guess or invent a
   preference.

3. Submit each answer you are confident about. The answer text must BEGIN with
   one of that question's `options` EXACTLY (case-insensitive), followed by one
   short sentence of reasoning in the user's voice:

   ```bash
   hearme-skill submit-answer --question-id "<question_id>" --answer "<option> — one short reason"
   ```

   It prints JSON `{"accepted", "reason", "question_id"}`. The CLI re-checks the
   user's policy and signs the answer locally before submitting.

4. Stop when there are no questions you can confidently answer. Never fabricate
   views your user does not hold.

## Reviewing or retracting (the user's override is sacred)

- Show what you have already submitted: `hearme-skill review-answers`
- Retract one answer: `hearme-skill revoke-answer --question-id "<question_id>"`

## Setup (only if the commands fail)

If `hearme-skill list-questions` reports `no-delegation`, the user has not
onboarded yet. Tell them to run `hearme-skill onboard` once (it walks the Self
identity flow). Do not attempt to onboard on their behalf.
"""


def openclaw_root() -> Path:
    """The OpenClaw home dir (``~/.openclaw``)."""

    return Path.home() / ".openclaw"


def openclaw_skills_dir() -> Path:
    """The global, all-agents skills dir OpenClaw scans (``~/.openclaw/skills``)."""

    return openclaw_root() / "skills"


def openclaw_env_path() -> Path:
    """The env file the OpenClaw gateway loads on startup (``~/.openclaw/.env``).

    OpenClaw's global env precedence reads this file, so it is the OpenClaw
    analog of ``~/.hermes/.env`` for making ``HEARME_SKILL_*`` overrides reach
    the scheduled answering process.
    """

    return openclaw_root() / ".env"


def openclaw_available() -> bool:
    """Best-effort: is OpenClaw installed on this box?

    True if the ``openclaw`` CLI is on PATH or ``~/.openclaw`` exists. Used by
    the host-aware ``onboard`` flow to decide which adapters to wire up.
    """

    return shutil.which("openclaw") is not None or openclaw_root().exists()


def install_openclaw_skill(*, skills_dir: Path | None = None) -> Path:
    """Write the OpenClaw skill drop-in. Idempotent.

    Creates ``<skills_dir>/hearme/SKILL.md`` (defaulting to the global
    ``~/.openclaw/skills``) and returns the skill directory. Always overwrites
    SKILL.md so a stale copy is cleanly replaced.
    """

    base = skills_dir or openclaw_skills_dir()
    target = base / SKILL_NAME
    target.mkdir(parents=True, exist_ok=True)
    (target / "SKILL.md").write_text(SKILL_MD)
    return target


def ensure_openclaw_cron(
    *,
    schedule: str | None = None,
    message: str | None = None,
) -> dict:
    """Register the recurring answering run with OpenClaw's scheduler. Best-effort.

    Shells out to the ``openclaw`` CLI (the scheduler is part of the gateway, not
    a Python API we can import). Idempotent: a job named :data:`CRON_NAME` is
    created once, detected via ``openclaw cron list``. Never raises — returns a
    structured result the caller can report:

    * ``{"created": True, "name": ...}`` — job registered.
    * ``{"created": False, "name": ..., "reason": "already present"}`` — existed.
    * ``{"created": False, "skipped": True, "reason": ...}`` — couldn't run
      (no CLI / scheduler error). Caller prints a hint to register by hand.
    """

    exe = shutil.which("openclaw")
    if not exe:
        return {"created": False, "skipped": True, "reason": "openclaw CLI not found on PATH"}

    sched = schedule or DEFAULT_SCHEDULE
    msg = message or CRON_MESSAGE

    # Idempotency: skip if a job with our name already exists.
    try:
        listing = subprocess.run(
            [exe, "cron", "list"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if CRON_NAME in (listing.stdout or ""):
            return {"created": False, "name": CRON_NAME, "reason": "already present"}
    except Exception:  # noqa: BLE001 — listing is only an optimisation; fall through
        log.debug("openclaw cron list failed; attempting create anyway", exc_info=True)

    try:
        subprocess.run(
            [
                exe,
                "cron",
                "add",
                "--name",
                CRON_NAME,
                "--cron",
                sched,
                "--session",
                "isolated",
                "--message",
                msg,
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
        return {"created": True, "name": CRON_NAME}
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or exc.stdout or "").strip() or f"exit {exc.returncode}"
        return {"created": False, "skipped": True, "name": CRON_NAME, "reason": detail}
    except Exception as exc:  # noqa: BLE001
        return {"created": False, "skipped": True, "name": CRON_NAME, "reason": str(exc)}
