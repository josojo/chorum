"""Identity-inference separation (§1.4, §7.4, §12).

The Answerer must never see the DelegationToken or `unique_identifier`.
Enforced two ways:

1. The function signature: ``answer(persona, question, llm, *, style_guide)``
   has no parameter for the token or for the identifier.
2. A spying LLM double asserts on its call args; the call shape (`LLMRequest`)
   has no fields for them either.

If either path ever changes, this test fails.
"""

from __future__ import annotations

import dataclasses
import inspect

from hearme_skill.answerer import answer
from hearme_skill.llm.client import LLMClient, LLMRequest, LLMResponse
from hearme_skill.memory.mem0_stub import Mem0StubProvider
from hearme_skill.persona import project


class SpyingLLM(LLMClient):
    """LLM double that fails loudly if anything identity-shaped is passed in."""

    def __init__(self) -> None:
        self.calls: list[LLMRequest] = []

    def complete(self, req: LLMRequest) -> LLMResponse:
        self.calls.append(req)
        flat = repr(req)
        # These tokens cannot appear in the LLM request under any path.
        for forbidden in (
            "DelegationToken",
            "delegation_token",
            "unique_identifier",
            "zkpassport_proof",
            "phone_signature",
        ):
            assert forbidden not in flat, (
                f"LLM request leaked identity field {forbidden!r}: {flat!r}"
            )
        return LLMResponse(text="ok", rationale="")


def test_answer_signature_has_no_identity_params():
    """No parameter named like a token / identifier on the public answer fn."""

    sig = inspect.signature(answer)
    forbidden = {"delegation_token", "unique_identifier", "token", "uid", "passport"}
    assert set(sig.parameters) & forbidden == set()


def test_llm_request_has_no_identity_fields():
    field_names = {f.name for f in dataclasses.fields(LLMRequest)}
    forbidden = {"delegation_token", "unique_identifier", "passport", "phone_signature"}
    assert field_names & forbidden == set()


def test_spying_llm_never_receives_identity_fields(fresh_token, question):
    persona = project(question, Mem0StubProvider())
    spy = SpyingLLM()
    out = answer(persona, question, spy)
    assert out.text == "ok"
    # Confirm the spy was invoked (otherwise the asserts inside never ran).
    assert len(spy.calls) == 1


def test_persona_projection_has_no_demographics(question):
    """Belt for the same property at the layer above."""

    persona = project(question, Mem0StubProvider())
    blob = repr(persona.model_dump())
    for word in ("age_band", "region", "country", "gender", "ethnicity"):
        assert word not in blob, f"persona leaks demographic-shaped field {word!r}"
