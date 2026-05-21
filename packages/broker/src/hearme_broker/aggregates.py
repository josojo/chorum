"""Aggregate helpers.

Accepted envelopes increment the ``aggregates`` row inside the same
transaction as the envelope INSERT, so a reader can never see
``total_answers`` drift from accepted envelope count.

The shape of ``by_predicate`` matches the schema comment and §3 of
ARCHITECTURE.md: ``{"region:EU": 42, "age_band:25-34": 17, ...}`` — one
counter per (predicate_name, predicate_value) pair across all envelopes
for the question.
"""

from __future__ import annotations

import json
from typing import Any


def compute_by_predicate(envelopes: list[dict[str, Any]]) -> dict[str, int]:
    """Pure function — easy to unit-test."""
    out: dict[str, int] = {}
    for env in envelopes:
        preds = env.get("disclosed_predicates") or {}
        if isinstance(preds, str):
            preds = json.loads(preds)
        for k, v in preds.items():
            key = f"{k}:{v}"
            out[key] = out.get(key, 0) + 1
    return out
