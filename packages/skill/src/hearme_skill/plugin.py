"""Hermes plugin adapter (hermes-agent >= 0.14).

Hermes discovers this via the ``hermes_agent.plugins`` entry point (see
``pyproject.toml``) or as ``~/.hermes/plugins/hearme/``. It calls
:func:`register` once at load time; we expose two tools, both thin wrappers
over the framework-agnostic core in ``tools.py``:

* ``hearme_list_open_questions`` — questions the user's policy permits answering.
* ``hearme_submit_answer`` — sign + submit one answer the agent decided on.

Inference is the host agent's job: when the cron job (``schedule.py``) fires,
Hermes runs *its own* configured model over these tools. There is no second
API key and no model SDK imported here — that is the whole point of the
redesign.

The Hermes contract (verified against 0.14.0,
``hermes_cli/plugins.py:PluginContext``):

* ``register(ctx)`` is the entry function.
* ``ctx.register_tool(name, toolset, schema, handler, ...)`` — ``schema`` is an
  OpenAI-style ``{"name", "description", "parameters"}`` dict; ``handler`` is a
  sync ``(args: dict, **kwargs) -> str`` returning a JSON string.
"""

from __future__ import annotations

import json
import logging

from .tools import list_open_questions, submit_answer

log = logging.getLogger("hearme_skill.plugin")

TOOLSET = "hearme"

_LIST_SCHEMA = {
    "name": "hearme_list_open_questions",
    "description": (
        "List the open Hearme questions the user's policy permits you to answer "
        "on their behalf. Returns {questions: [{question_id, text, topic, "
        "options, closes_at}], skipped_count}. Each question's `options` array "
        "lists the only allowed answers (e.g. ['yes','no'] or ['pizza','pasta',"
        "'sushi']). Call this first."
    ),
    "parameters": {"type": "object", "properties": {}, "required": []},
}

_SUBMIT_SCHEMA = {
    "name": "hearme_submit_answer",
    "description": (
        "Submit the user's answer to one Hearme question. The answer must begin "
        "with one of the question's options EXACTLY (case-insensitive), "
        "followed by one short sentence of reasoning in the user's voice, "
        "based only on what you actually know about them. Only call this for "
        "questions returned by hearme_list_open_questions. Returns {accepted, "
        "reason, question_id}."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "question_id": {
                "type": "string",
                "description": "The question_id from hearme_list_open_questions.",
            },
            "answer": {
                "type": "string",
                "description": (
                    "The user's answer: start with one of the question's "
                    "options exactly, then one short sentence."
                ),
            },
        },
        "required": ["question_id", "answer"],
    },
}


def _handle_list(args: dict, **_kwargs) -> str:
    return json.dumps(list_open_questions())


def _handle_submit(args: dict, **_kwargs) -> str:
    question_id = str((args or {}).get("question_id") or "").strip()
    answer = str((args or {}).get("answer") or "").strip()
    if not question_id or not answer:
        return json.dumps(
            {"accepted": False, "reason": "question_id and answer are required"}
        )
    return json.dumps(submit_answer(question_id, answer))


def register(ctx) -> None:
    """Hermes plugin entry point."""

    ctx.register_tool(
        name="hearme_list_open_questions",
        toolset=TOOLSET,
        schema=_LIST_SCHEMA,
        handler=_handle_list,
        description="List open Hearme questions the policy permits answering.",
        emoji="🗳️",
    )
    ctx.register_tool(
        name="hearme_submit_answer",
        toolset=TOOLSET,
        schema=_SUBMIT_SCHEMA,
        handler=_handle_submit,
        description="Sign + submit one Hearme answer on the user's behalf.",
        emoji="🗳️",
    )

    # Self-schedule the recurring answering cycle once the user has onboarded
    # (a deliberate act that creates the delegation token). Best-effort: never
    # let a scheduling hiccup break plugin load.
    try:
        from .schedule import ensure_cron_job_if_onboarded

        result = ensure_cron_job_if_onboarded()
        if result and result.get("created"):
            log.info("registered Hearme cron job: %s", result.get("job_id"))
    except Exception:  # noqa: BLE001
        log.debug("Hearme cron auto-registration skipped", exc_info=True)
