"""Tests for the framework-agnostic answering tools (`tools.py`).

These cover the contract the Hermes plugin (and any future framework adapter)
relies on:

* the policy gate is a HARD backstop, re-checked on submit (§1.12 cron note);
* replay-safety (§1.9) — an accepted question is never re-submitted;
* the delegation token / `unique_identifier` / nonce never appear in the
  model-facing tool results.

No live LLM and no live network: the broker is an in-process `httpx.MockTransport`
(per ARCHITECTURE.md §12).
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

import httpx

from hearme_skill.config import Settings
from hearme_skill.crypto.keystore import store_agent_keypair
from hearme_skill.delegation import store_delegation
from hearme_skill.models import Question
from hearme_skill.tools import list_open_questions, submit_answer


def _settings(tmp_root) -> Settings:
    return Settings(root_dir=tmp_root, broker_url="http://broker.test")


def _write_policy(settings: Settings, *, auto_answer: bool, allow=("coffee",), block=()) -> None:
    lines = [f"auto_answer: {str(auto_answer).lower()}", "max_answers_per_day: 50"]
    if allow:
        lines.append("topic_allowlist:")
        lines += [f"  - {t}" for t in allow]
    if block:
        lines.append("topic_blocklist:")
        lines += [f"  - {t}" for t in block]
    settings.policy_path.write_text("\n".join(lines) + "\n")


def _broker(questions: list[Question], *, posted: list | None = None, accept: bool = True):
    """An httpx.MockTransport standing in for the broker."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/questions/open" and request.method == "GET":
            return httpx.Response(200, json=[q.model_dump(mode="json") for q in questions])
        if request.url.path == "/v1/envelopes" and request.method == "POST":
            if posted is not None:
                import json

                posted.append(json.loads(request.content))
            return httpx.Response(200, json={"accepted": accept, "reason": "ok" if accept else "nope"})
        return httpx.Response(404, json={"reason": "unexpected"})

    return httpx.MockTransport(handler)


def _question(topic: str = "coffee") -> Question:
    import base64

    return Question(
        question_id=str(uuid.uuid4()),
        text="Do you prefer single-origin or blends?",
        topic=topic,
        created_at=datetime(2026, 5, 19, 12, 0, 0, tzinfo=timezone.utc),
        closes_at=datetime(2099, 1, 1, 0, 0, 0, tzinfo=timezone.utc),
        nonce=base64.b64encode(b"n" * 16).decode("ascii"),
    )


# --- list_open_questions --------------------------------------------------


def test_list_surfaces_only_policy_permitted(tmp_root, fresh_token):
    settings = _settings(tmp_root)
    store_delegation(settings.delegation_path, fresh_token)
    _write_policy(settings, auto_answer=True, allow=("coffee",))
    q = _question("coffee")

    result = list_open_questions(settings=settings, transport=_broker([q]))

    assert [item["question_id"] for item in result["questions"]] == [q.question_id]
    assert result["skipped_count"] == 0


def test_list_skips_when_auto_answer_off(tmp_root, fresh_token):
    settings = _settings(tmp_root)
    store_delegation(settings.delegation_path, fresh_token)
    _write_policy(settings, auto_answer=False, allow=("coffee",))

    result = list_open_questions(settings=settings, transport=_broker([_question("coffee")]))

    assert result["questions"] == []
    assert result["skipped_count"] == 1


def test_list_respects_topic_blocklist(tmp_root, fresh_token):
    settings = _settings(tmp_root)
    store_delegation(settings.delegation_path, fresh_token)
    _write_policy(settings, auto_answer=True, allow=(), block=("politics",))

    result = list_open_questions(settings=settings, transport=_broker([_question("politics")]))

    assert result["questions"] == []
    assert result["skipped_count"] == 1


def test_list_results_never_carry_nonce_or_identity(tmp_root, fresh_token):
    settings = _settings(tmp_root)
    store_delegation(settings.delegation_path, fresh_token)
    _write_policy(settings, auto_answer=True, allow=("coffee",))
    q = _question("coffee")

    result = list_open_questions(settings=settings, transport=_broker([q]))

    blob = repr(result)
    assert q.nonce not in blob
    assert fresh_token.unique_identifier not in blob
    assert set(result["questions"][0]) == {"question_id", "text", "topic", "closes_at"}


# --- submit_answer --------------------------------------------------------


def _prime_agent_key(settings: Settings) -> None:
    from hearme_skill.crypto.ed25519 import generate_keypair

    store_agent_keypair(settings.agent_key_path, generate_keypair())


def test_submit_happy_path_and_replay_safety(tmp_root, fresh_token):
    settings = _settings(tmp_root)
    store_delegation(settings.delegation_path, fresh_token)
    _prime_agent_key(settings)
    _write_policy(settings, auto_answer=True, allow=("coffee",))
    q = _question("coffee")
    posted: list = []
    transport = _broker([q], posted=posted)

    first = submit_answer(q.question_id, "Yes, single-origin every time.", settings=settings, transport=transport)
    assert first["accepted"] is True

    # The wire body is exactly the five canonical envelope fields.
    assert set(posted[0]) == {"question_id", "answer", "nonce", "delegation_token", "agent_signature"}

    # §1.9 — a second submit for the same question is refused locally.
    second = submit_answer(q.question_id, "No, blends.", settings=settings, transport=_broker([q]))
    assert second["accepted"] is False
    assert second["reason"] == "already-submitted"


def test_submit_policy_backstop_blocks_disallowed_topic(tmp_root, fresh_token):
    """Even if the agent calls submit, the tool refuses a non-permitted question."""

    settings = _settings(tmp_root)
    store_delegation(settings.delegation_path, fresh_token)
    _prime_agent_key(settings)
    _write_policy(settings, auto_answer=False, allow=("coffee",))  # auto_answer off
    q = _question("coffee")

    result = submit_answer(q.question_id, "Yes.", settings=settings, transport=_broker([q]))

    assert result["accepted"] is False
    assert result["reason"].startswith("policy-declined")


def test_submit_without_delegation_is_refused(tmp_root):
    settings = _settings(tmp_root)
    _write_policy(settings, auto_answer=True, allow=("coffee",))
    q = _question("coffee")

    result = submit_answer(q.question_id, "Yes.", settings=settings, transport=_broker([q]))

    assert result["accepted"] is False
    assert result["reason"] == "no-delegation"


def test_submit_expired_delegation_is_refused(tmp_root, expired_token):
    settings = _settings(tmp_root)
    store_delegation(settings.delegation_path, expired_token)
    _prime_agent_key(settings)
    _write_policy(settings, auto_answer=True, allow=("coffee",))
    q = _question("coffee")

    result = submit_answer(q.question_id, "Yes.", settings=settings, transport=_broker([q]))

    assert result["accepted"] is False
    assert result["reason"] == "delegation-expired"


def test_submit_unknown_question_is_refused(tmp_root, fresh_token):
    settings = _settings(tmp_root)
    store_delegation(settings.delegation_path, fresh_token)
    _prime_agent_key(settings)
    _write_policy(settings, auto_answer=True, allow=("coffee",))

    # Broker has no open questions, so the id can't be matched.
    result = submit_answer("does-not-exist", "Yes.", settings=settings, transport=_broker([]))

    assert result["accepted"] is False
    assert result["reason"] == "question-not-open"


def test_submit_empty_answer_is_refused(tmp_root, fresh_token):
    settings = _settings(tmp_root)
    store_delegation(settings.delegation_path, fresh_token)
    result = submit_answer("anything", "   ", settings=settings, transport=_broker([]))
    assert result["accepted"] is False
    assert result["reason"] == "empty-answer"


def test_submit_result_never_carries_identity(tmp_root, fresh_token):
    settings = _settings(tmp_root)
    store_delegation(settings.delegation_path, fresh_token)
    _prime_agent_key(settings)
    _write_policy(settings, auto_answer=True, allow=("coffee",))
    q = _question("coffee")

    result = submit_answer(q.question_id, "Yes, single-origin.", settings=settings, transport=_broker([q]))

    blob = repr(result)
    assert fresh_token.unique_identifier not in blob
    assert fresh_token.broker_signature not in blob
    assert q.nonce not in blob
    assert set(result) == {"accepted", "reason", "question_id"}
