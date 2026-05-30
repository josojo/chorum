"""Policy — § 7.2.

Pure function. Reads user policy from YAML at ``~/.hermes/hearme/policy.yaml``.

Per §1.7 ("Indistinguishable response fidelity"), this layer MUST NOT branch
on whether the question is a honeypot. It does not inspect question text for
test markers; it only consults the user's declared topic policy and ledger
stats.

Per §11, payment fields are absent in v0 — `min_payment` is parsed for
forward-compat but never read.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from .models import Decision, Question

# Curated "light topics" the agent may answer UNATTENDED by default, even when
# the global `auto_answer` opt-in is off. These are low-stakes, low-sensitivity
# subjects (hobbies, tech, AI/agents, entertainment) where an honest off-the-cuff
# opinion carries little privacy or reputational risk — so out of the box the
# cron actually answers something instead of sitting idle. Anything political,
# medical, financial, religious, or otherwise sensitive is deliberately ABSENT
# and still requires the explicit `auto_answer: true` opt-in (§1.1, §1.12).
#
# Stored as single lowercase word-tokens; a question's free-form `topic` tag is
# tokenised and matched against this set (see `_is_light_topic`), so the tag
# "ai agents" matches `ai`, while "fair" does not match `ai`. Users override the
# whole set via `auto_answer_topics:` in policy.yaml (an empty list disables it).
DEFAULT_AUTO_ANSWER_TOPICS: frozenset[str] = frozenset(
    {
        # AI / agents — the project's own home turf
        "ai", "agent", "agents", "llm", "llms", "ml", "genai",
        # software / IT
        "it", "tech", "technology", "software", "hardware", "programming",
        "coding", "code", "dev", "developer", "devops", "computers", "computer",
        "internet", "web", "gadgets", "opensource",
        # hobbies / lifestyle / entertainment
        "hobby", "hobbies", "gaming", "games", "game", "music", "movies",
        "movie", "film", "films", "tv", "books", "reading", "food", "cooking",
        "travel", "sports", "sport", "fitness", "photography", "art", "design",
        "science", "space", "productivity",
    }
)

_WORD_RE = re.compile(r"[a-z0-9]+")


def _is_light_topic(topic: str, keywords: frozenset[str]) -> bool:
    """True when the (already lowercased) topic tag contains a keyword word-token.

    Word-token matching, not substring: "ai agents" matches `ai`, but "fair"
    does not. An empty topic never matches — untagged questions are not
    auto-answered by the light-topic default (the asker gave nothing to gate on).
    """

    if not topic or not keywords:
        return False
    return any(tok in keywords for tok in _WORD_RE.findall(topic))


@dataclass(frozen=True)
class LedgerStats:
    """Inputs the Policy layer needs from the local ledger."""

    answered_today: int = 0
    has_active_delegation: bool = True
    already_answered_ids: frozenset[str] = field(default_factory=frozenset)


@dataclass(frozen=True)
class UserPolicy:
    topic_allowlist: frozenset[str] = field(default_factory=frozenset)
    topic_blocklist: frozenset[str] = field(default_factory=frozenset)
    max_answers_per_day: int = 50
    # v0: ignored (no payment field on questions). Carried for forward-compat.
    min_payment: float = 0.0
    auto_submit_window_seconds: int = 0
    # If False, the layer always returns "prompt_user" rather than "answer"
    # for questions OUTSIDE `auto_answer_topics` — § 1.12 override is sacred.
    # Setting it True opts every eligible question (tagged or not) into
    # unattended answering.
    auto_answer: bool = False
    # Light-topic auto-answer: questions whose topic tag matches one of these
    # word-tokens are answered unattended even when `auto_answer` is False, so
    # the cron isn't a no-op out of the box. Defaults to the curated low-stakes
    # set; override (or empty out) per-install via policy.yaml.
    auto_answer_topics: frozenset[str] = DEFAULT_AUTO_ANSWER_TOPICS

    @classmethod
    def default(cls) -> "UserPolicy":
        # Sensitive topics stay opt-in (§1.1); low-stakes "light topics"
        # answer by default so a freshly-onboarded agent participates.
        return cls()


def load_policy(path: Path) -> UserPolicy:
    """Parse YAML policy from disk. Missing file → default (everything off)."""

    if not path.exists():
        return UserPolicy.default()
    raw = yaml.safe_load(path.read_text()) or {}
    # Absent key → curated default; present (incl. empty list) → honour it, so a
    # user can broaden, narrow, or disable (`auto_answer_topics: []`) the set.
    raw_topics = raw.get("auto_answer_topics")
    if raw_topics is None:
        auto_answer_topics = DEFAULT_AUTO_ANSWER_TOPICS
    else:
        auto_answer_topics = frozenset(str(t).lower().strip() for t in raw_topics)
    return UserPolicy(
        topic_allowlist=frozenset(raw.get("topic_allowlist") or []),
        topic_blocklist=frozenset(raw.get("topic_blocklist") or []),
        max_answers_per_day=int(raw.get("max_answers_per_day", 50)),
        min_payment=float(raw.get("min_payment", 0.0)),
        auto_submit_window_seconds=int(raw.get("auto_submit_window_seconds", 0)),
        auto_answer=bool(raw.get("auto_answer", False)),
        auto_answer_topics=auto_answer_topics,
    )


def decide(
    question: Question,
    policy: UserPolicy,
    stats: LedgerStats,
) -> Decision:
    """Pure decision function (§7.2).

    Note: deliberately does NOT inspect `question.text` for honeypot markers
    (§1.7). The only question property consulted is topic; asker identity is
    not part of the v0 broker protocol.
    """

    if not stats.has_active_delegation:
        return Decision(action="decline", reason="no active delegation token")

    if question.question_id in stats.already_answered_ids:
        # §1.9 idempotent. Don't re-answer.
        return Decision(action="decline", reason="already answered")

    if stats.answered_today >= policy.max_answers_per_day:
        return Decision(action="decline", reason="daily cap reached")

    topic = (question.topic or "").lower().strip()
    if topic and topic in policy.topic_blocklist:
        return Decision(action="decline", reason=f"topic blocked: {topic}")
    if policy.topic_allowlist and topic not in policy.topic_allowlist:
        return Decision(action="decline", reason=f"topic not in allowlist: {topic or '<none>'}")

    # Global opt-in: answer every eligible question unattended.
    if policy.auto_answer:
        return Decision(action="answer", reason="policy match")

    # Default path: low-stakes "light topics" answer unattended; everything else
    # waits for the user (§1.12). This is why the cron isn't idle out of the box.
    if _is_light_topic(topic, policy.auto_answer_topics):
        return Decision(action="answer", reason=f"light-topic auto-answer: {topic}")

    return Decision(action="prompt_user", reason="auto-answer disabled (default)")
