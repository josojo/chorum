"""Register the recurring Hermes cron job that drives answering.

The redesign replaces the in-process ``while True`` poll loop with a Hermes
cron job: the ``hermes gateway`` daemon fires it on a schedule, spins up the
user's configured agent, and lets it answer open questions through the
``hearme`` toolset. Inference uses the host model — no second API key.

The ``cron`` package ships with ``hermes-agent`` (>= 0.14); we import it lazily
so this module is import-safe in CI / dev environments that don't have Hermes
installed.

Verified API (hermes-agent 0.14.0, ``cron/jobs.py``):
    create_job(prompt, schedule, name=None, ..., enabled_toolsets=None,
               model=None, provider=None, ...) -> dict
    resolve_job_ref(ref) -> dict | None   # ref = id or name
"""

from __future__ import annotations

import logging

from .config import get_settings

log = logging.getLogger("hearme_skill.schedule")

JOB_NAME = "hearme-answer-cycle"
# Hermes accepts "every 15m", a cron expression, or an ISO one-shot. Recurring
# every 15 minutes balances responsiveness against host model cost.
DEFAULT_SCHEDULE = "every 15m"

# The behavioural contract handed to the host agent each cycle. It must answer
# only from genuine knowledge of the user (the host model + its memory) and
# never fabricate opinions — the deterministic policy/replay guard lives in the
# tools, but honesty is the agent's job.
ANSWER_PROMPT = (
    "You answer public yes/no questions on behalf of your user, in their voice.\n"
    "\n"
    "1. Call hearme_list_open_questions to get the questions your user's policy "
    "permits answering.\n"
    "2. For each question, decide your user's honest answer based ONLY on what "
    "you actually know about them from your memory and past conversations. If "
    "you do not genuinely know how they would answer, SKIP it — do not guess or "
    "invent a preference.\n"
    "3. Write the answer beginning with 'Yes' or 'No', then one short sentence "
    "of reasoning in their voice.\n"
    "4. Submit each answer with hearme_submit_answer(question_id=..., answer=...).\n"
    "\n"
    "When there are no questions you can confidently answer, stop. Never "
    "fabricate views your user does not hold."
)


def ensure_cron_job(
    *,
    schedule: str | None = None,
    model: str | None = None,
    provider: str | None = None,
) -> dict:
    """Create the Hearme answering cron job if it doesn't already exist.

    Idempotent: a job named :data:`JOB_NAME` is created once. Returns
    ``{"created": bool, "job_id": str | None, "name": str}``. Raises if the
    ``cron`` package (i.e. Hermes) isn't importable — callers that want
    best-effort behaviour should catch that.
    """

    from cron.jobs import create_job, resolve_job_ref  # lazy: needs hermes-agent

    existing = resolve_job_ref(JOB_NAME)
    if existing:
        return {"created": False, "job_id": existing.get("id"), "name": JOB_NAME}

    job = create_job(
        prompt=ANSWER_PROMPT,
        schedule=schedule or DEFAULT_SCHEDULE,
        name=JOB_NAME,
        enabled_toolsets=["hearme"],
        model=model,
        provider=provider,
    )
    return {"created": True, "job_id": job.get("id"), "name": JOB_NAME}


def ensure_cron_job_if_onboarded() -> dict | None:
    """Register the cron job only once a delegation token exists.

    Called from ``plugin.register`` so installing the plugin and onboarding is
    all it takes to start the recurring answering cycle. Returns ``None`` (no
    action) when the user hasn't onboarded yet.
    """

    settings = get_settings()
    if not settings.delegation_path.exists():
        return None
    return ensure_cron_job()
