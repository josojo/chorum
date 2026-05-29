"""LLM client protocol + a deterministic fake.

Tests inject `FakeLLMClient`. Per ARCHITECTURE.md §12, we never make a live
LLM call in CI. Production deployments wire a real client that conforms to
this protocol.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol


@dataclass(frozen=True)
class LLMRequest:
    """Single LLM call shape.

    The Answerer never includes the DelegationToken or `unique_identifier`
    in this request — ARCHITECTURE.md §1.4, §7.4 separate identity from
    inference.
    """

    question_text: str
    persona_facts: tuple[str, ...]
    style_hints: tuple[str, ...]
    # Ordered list of allowed answer labels. The model MUST lead with one of
    # these (case-insensitive). Default ['yes','no'] keeps the legacy flow.
    options: tuple[str, ...] = ("yes", "no")
    style_guide: str = ""


@dataclass(frozen=True)
class LLMResponse:
    text: str
    # Local-only rationale. The Envelope layer never reads this field.
    rationale: str = ""


class LLMClient(Protocol):
    def complete(self, req: LLMRequest) -> LLMResponse: ...


@dataclass
class FakeLLMClient:
    """Deterministic, recorded-response client for tests.

    Behavior:
    * If `responses` maps the request's `question_text` to a response, return it.
    * Else return a default response that echoes the persona facts (so
      tests can assert that persona projection was actually used).
    * Track every call in `calls` so the identity-inference separation
      test can assert on argument types.
    """

    responses: dict[str, LLMResponse] = field(default_factory=dict)
    calls: list[LLMRequest] = field(default_factory=list)

    def complete(self, req: LLMRequest) -> LLMResponse:
        self.calls.append(req)
        if req.question_text in self.responses:
            return self.responses[req.question_text]
        body = "; ".join(req.persona_facts) if req.persona_facts else "no opinion"
        # Lead with the first allowed option so the broker's classifier
        # has a clean leading-word match without any prompt-engineering work
        # in the test surface.
        lead = req.options[0] if req.options else "yes"
        return LLMResponse(text=f"{lead} — {body}", rationale="fake rationale")
