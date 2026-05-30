"""Policy tests — deterministic gate decisions (§7.2, §12).

The policy layer is a pure function; tests are unit-level and don't touch
the filesystem.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from hearme_skill.policy import LedgerStats, UserPolicy, decide, load_policy


def test_decline_when_no_delegation(question):
    stats = LedgerStats(answered_today=0, has_active_delegation=False)
    d = decide(question, UserPolicy.default(), stats)
    assert d.action == "decline"
    assert "delegation" in d.reason


def test_decline_when_already_answered(question):
    stats = LedgerStats(already_answered_ids=frozenset({question.question_id}))
    d = decide(question, UserPolicy(auto_answer=True), stats)
    assert d.action == "decline"
    assert "already" in d.reason


def test_decline_when_topic_blocked(question):
    p = UserPolicy(topic_blocklist=frozenset({"coffee"}), auto_answer=True)
    d = decide(question, p, LedgerStats())
    assert d.action == "decline"


def test_decline_when_topic_not_in_allowlist(question):
    p = UserPolicy(topic_allowlist=frozenset({"travel"}), auto_answer=True)
    d = decide(question, p, LedgerStats())
    assert d.action == "decline"


def test_decline_when_daily_cap(question):
    p = UserPolicy(max_answers_per_day=3, auto_answer=True)
    d = decide(question, p, LedgerStats(answered_today=3))
    assert d.action == "decline"


def test_default_policy_declines_non_light(question):
    # § 1.1: defaults to off; opt-in per category. A non-light topic ('coffee')
    # under the default policy declines unattended rather than nagging the user —
    # prompts cost the user too much attention to be the default (§1.12).
    p = UserPolicy(topic_allowlist=frozenset({"coffee"}))
    d = decide(question, p, LedgerStats())
    assert d.action == "decline"


def test_answer_when_policy_matches_and_auto_answer_on(question):
    p = UserPolicy(topic_allowlist=frozenset({"coffee"}), auto_answer=True)
    d = decide(question, p, LedgerStats())
    assert d.action == "answer"


def test_policy_does_not_branch_on_question_text(question):
    """§1.7: policy MUST NOT inspect question text for honeypot markers."""

    # Inject obvious honeypot strings; decision must be unchanged.
    p = UserPolicy(topic_allowlist=frozenset({"coffee"}), auto_answer=True)
    baseline = decide(question, p, LedgerStats())
    for marker in ("HONEYPOT", "[TEST]", "is this a test?"):
        spiked = question.model_copy(update={"text": question.text + " " + marker})
        d = decide(spiked, p, LedgerStats())
        assert d.action == baseline.action, f"policy branched on text containing {marker!r}"


def test_load_policy_missing_file_returns_default(tmp_path: Path):
    p = load_policy(tmp_path / "missing.yaml")
    assert p == UserPolicy.default()


def test_load_policy_yaml(tmp_path: Path):
    path = tmp_path / "policy.yaml"
    path.write_text(
        "topic_allowlist:\n  - coffee\n"
        "max_answers_per_day: 5\n"
        "auto_answer: true\n"
        "auto_submit_window_seconds: 10\n"
    )
    p = load_policy(path)
    assert "coffee" in p.topic_allowlist
    assert p.max_answers_per_day == 5
    assert p.auto_answer is True
    assert p.auto_submit_window_seconds == 10


@pytest.mark.parametrize("answered,expected", [(0, "answer"), (49, "answer"), (50, "decline")])
def test_daily_cap_boundary(question, answered, expected):
    p = UserPolicy(topic_allowlist=frozenset({"coffee"}), auto_answer=True, max_answers_per_day=50)
    d = decide(question, p, LedgerStats(answered_today=answered))
    assert d.action == expected


# --- light-topic auto-answer (fix "cron answers nothing out of the box") -------


@pytest.mark.parametrize("topic", ["ai", "AI", "agents", "it", "hobbies", "gaming"])
def test_light_topic_answers_by_default(question, topic):
    # Default policy (auto_answer=False) still answers low-stakes topics so the
    # cron isn't a no-op. The fixture topic 'coffee' is intentionally NOT light.
    q = question.model_copy(update={"topic": topic})
    d = decide(q, UserPolicy.default(), LedgerStats())
    assert d.action == "answer"
    assert "light-topic" in d.reason


def test_light_topic_word_token_match(question):
    # Multi-word tag matches on a token; an unrelated word that merely contains
    # a keyword as a substring ("fair" ⊃ "ai") does NOT match.
    assert decide(question.model_copy(update={"topic": "ai agents"}),
                  UserPolicy.default(), LedgerStats()).action == "answer"
    assert decide(question.model_copy(update={"topic": "fair"}),
                  UserPolicy.default(), LedgerStats()).action == "decline"


def test_non_light_topic_declines_by_default(question):
    # 'coffee' (fixture) and untagged questions are not in the light set, so the
    # default policy declines them unattended instead of prompting the user.
    assert decide(question, UserPolicy.default(), LedgerStats()).action == "decline"
    assert decide(question.model_copy(update={"topic": None}),
                  UserPolicy.default(), LedgerStats()).action == "decline"


def test_blocklist_overrides_light_topic(question):
    p = UserPolicy(topic_blocklist=frozenset({"ai"}))
    d = decide(question.model_copy(update={"topic": "ai"}), p, LedgerStats())
    assert d.action == "decline"


def test_light_topics_can_be_disabled(question):
    # Empty auto_answer_topics + auto_answer off ⇒ back to declining everything
    # unattended (the user opted out of the light-topic default).
    p = UserPolicy(auto_answer_topics=frozenset())
    d = decide(question.model_copy(update={"topic": "ai"}), p, LedgerStats())
    assert d.action == "decline"


def test_load_policy_defaults_light_topics(tmp_path: Path):
    # A YAML without the key inherits the curated default set.
    path = tmp_path / "policy.yaml"
    path.write_text("max_answers_per_day: 5\n")
    assert "ai" in load_policy(path).auto_answer_topics


def test_load_policy_auto_answer_topics_override(tmp_path: Path):
    path = tmp_path / "policy.yaml"
    path.write_text("auto_answer_topics:\n  - knitting\n  - Chess\n")
    topics = load_policy(path).auto_answer_topics
    assert topics == frozenset({"knitting", "chess"})  # lowercased, no defaults
    assert "ai" not in topics
