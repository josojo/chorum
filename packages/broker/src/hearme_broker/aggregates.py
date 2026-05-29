"""Aggregate helpers.

Accepted envelopes increment the ``aggregates`` row inside the same
transaction as the envelope INSERT, so a reader can never see
``total_answers`` drift from accepted envelope count.

Questions carry an ordered ``options`` list (default ``["yes", "no"]``).
``by_predicate`` records per-option counts inside each disclosed-predicate
bucket, e.g. for a yes/no poll::

    {"region:EU": {"yes": 30, "no": 12}, "age_band:25-34": {"yes": 20, "no": 10}}

and for an N-option poll the same shape carries arbitrary labels::

    {"region:EU": {"pizza": 22, "pasta": 14, "sushi": 9}, ...}

``total_answers`` remains the grand count of accepted envelopes; answers
whose leading word does not match any option still count toward the total
but are not added to any per-option bucket.
"""

from __future__ import annotations

import json
import re
from typing import Any, Iterable, Sequence

# Multilingual yes/no synonyms — used only when the question's options are
# the default ``["yes", "no"]`` so existing demo / seeded polls keep working.
_YES_WORDS = {
    "yes", "y", "yeah", "yep", "yup", "sure", "absolutely",
    "ja", "oui", "si", "sí", "sim", "da",
}
_NO_WORDS = {
    "no", "n", "nope", "nah", "never",
    "nein", "non", "não", "nao",
}


def _is_yes_no(options: Sequence[str]) -> bool:
    return (
        len(options) == 2
        and options[0].strip().lower() == "yes"
        and options[1].strip().lower() == "no"
    )


def _leading_word(answer: Any) -> str | None:
    if not isinstance(answer, str):
        return None
    match = re.match(r"\w+", answer.strip().lower(), re.UNICODE)
    return match.group(0) if match else None


def classify_answer(answer: Any, options: Sequence[str]) -> str | None:
    """Return the option label that ``answer`` selects, or ``None``.

    Match strategy: leading-word, case-insensitive — robust to LLM elaboration
    ("Pizza — because the crust …"). For the default ``["yes", "no"]`` poll we
    additionally accept multilingual yes/no synonyms so legacy seeded data and
    existing yes/no agents keep working.
    """
    word = _leading_word(answer)
    if word is None:
        return None
    by_label = {opt.strip().lower(): opt for opt in options}
    if word in by_label:
        return by_label[word]
    if _is_yes_no(options):
        if word in _YES_WORDS:
            return "yes"
        if word in _NO_WORDS:
            return "no"
    return None


# Back-compat alias: older call sites and tests assume yes/no semantics.
def classify_vote(answer: Any) -> str | None:
    return classify_answer(answer, ("yes", "no"))


def _empty_tally(options: Sequence[str]) -> dict[str, int]:
    return {opt: 0 for opt in options}


def compute_by_predicate(
    envelopes: Iterable[dict[str, Any]],
    options: Sequence[str] = ("yes", "no"),
) -> dict[str, dict[str, int]]:
    """Pure function — easy to unit-test.

    Each envelope contributes its classified option to every disclosed
    (predicate, value) bucket. Unclassified answers count toward
    ``total_answers`` (computed by the caller) but not toward any per-option
    bucket.
    """
    out: dict[str, dict[str, int]] = {}
    for env in envelopes:
        preds = env.get("disclosed_predicates") or {}
        if isinstance(preds, str):
            preds = json.loads(preds)
        choice = classify_answer(env.get("answer"), options)
        for k, v in preds.items():
            key = f"{k}:{v}"
            bucket = out.setdefault(key, _empty_tally(options))
            # Defensive: an option may have been added since the bucket was
            # first created; fill missing slots with 0 so the shape is stable.
            for opt in options:
                bucket.setdefault(opt, 0)
            if choice is not None:
                bucket[choice] = bucket.get(choice, 0) + 1
    return out
