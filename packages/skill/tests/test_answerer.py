"""Answerer tests — fake LLM client, no live calls (§12)."""

from __future__ import annotations

import base64
import uuid
from datetime import datetime, timezone

from hearme_skill.answerer import answer
from hearme_skill.llm.client import FakeLLMClient, LLMResponse
from hearme_skill.memory.mem0_stub import Mem0StubProvider
from hearme_skill.models import Question
from hearme_skill.persona import project


def test_answerer_uses_persona_facts(question):
    persona = project(question, Mem0StubProvider())
    llm = FakeLLMClient()
    out = answer(persona, question, llm)
    # Default fake reply concatenates persona facts; assert one shows up.
    assert "single-origin" in out.text


def test_answerer_recorded_response(question):
    persona = project(question, Mem0StubProvider())
    llm = FakeLLMClient(
        responses={
            question.text: LLMResponse(
                text="I prefer single-origin in the morning, blends in the afternoon.",
                rationale="recalled morning vs afternoon preference",
            )
        }
    )
    out = answer(persona, question, llm)
    assert out.text.startswith("I prefer single-origin")
    assert out.rationale == "recalled morning vs afternoon preference"


def test_answerer_never_makes_live_calls(question):
    """The FakeLLMClient is the only client touched. Assert via call log."""

    persona = project(question, Mem0StubProvider())
    llm = FakeLLMClient()
    answer(persona, question, llm)
    assert len(llm.calls) == 1


def test_answerer_returns_local_rationale(question):
    persona = project(question, Mem0StubProvider())
    llm = FakeLLMClient(
        responses={question.text: LLMResponse(text="OK", rationale="thinking out loud")}
    )
    out = answer(persona, question, llm)
    assert out.rationale == "thinking out loud"


def test_answerer_forwards_options_to_llm():
    """The Answerer must hand the option list to the LLM (so the model can
    constrain its output) — but never the DelegationToken / unique_identifier."""

    q = Question(
        question_id=str(uuid.uuid4()),
        text="Pizza, pasta, or sushi?",
        topic="food",
        options=["pizza", "pasta", "sushi"],
        created_at=datetime(2026, 5, 19, tzinfo=timezone.utc),
        closes_at=datetime(2026, 5, 20, tzinfo=timezone.utc),
        nonce=base64.b64encode(b"n" * 16).decode("ascii"),
    )
    persona = project(q, Mem0StubProvider())
    llm = FakeLLMClient()
    out = answer(persona, q, llm)
    assert len(llm.calls) == 1
    assert llm.calls[0].options == ("pizza", "pasta", "sushi")
    # FakeLLMClient leads with the first allowed option so the broker's
    # classifier has a clean match.
    assert out.text.lower().startswith("pizza")
