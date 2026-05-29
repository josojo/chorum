"""Answerer — § 7.4.

Single LLM call: ``(persona_projection, question, style_guide) -> Answer``.

Strict identity-inference separation per §1.4 / §7.4 / §12:

* This function NEVER receives the DelegationToken or `unique_identifier`.
  It accepts only the persona projection (no demographics), the question
  text, and an optional style guide. The test suite enforces this by
  injecting a double that asserts on its call args.

* `rationale` is local-only. It is returned to the caller for the audit
  ledger but the Envelope layer never reads it. The boundary-leakage test
  also confirms the envelope POST body never carries it.
"""

from __future__ import annotations

from .llm.client import LLMClient, LLMRequest
from .models import Answer, PersonaProjection, Question


def answer(
    persona: PersonaProjection,
    question: Question,
    llm: LLMClient,
    *,
    style_guide: str = "",
) -> Answer:
    """Single LLM call. No identity material in scope."""

    # NOTE: This function signature is the enforcement. We deliberately do
    # not accept DelegationToken / unique_identifier — there is no parameter
    # for them, and the broker boundary is two layers away.
    req = LLMRequest(
        question_text=question.text,
        persona_facts=tuple(persona.relevant_facts),
        style_hints=tuple(persona.style_hints),
        options=tuple(question.options),
        style_guide=style_guide,
    )
    resp = llm.complete(req)
    return Answer(text=resp.text, rationale=resp.rationale)
