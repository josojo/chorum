"""Pydantic wire-format models.

These are the **only** types that get serialized across the broker boundary
(see ARCHITECTURE.md §8.5). Field names and types must match `packages/proto/`
byte-for-byte; the end-to-end test asserts the envelope POST body contains
exactly these five fields and no others.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class Question(BaseModel):
    """Question record returned by GET /v1/questions/open.

    Mirrors `packages/proto/question.json`.
    """

    model_config = ConfigDict(extra="forbid")

    question_id: str
    text: str
    topic: str | None = None
    created_at: datetime
    closes_at: datetime
    nonce: str


class DelegationToken(BaseModel):
    """Delegation bundle authorizing an agent_key to speak for a human
    (ARCHITECTURE.md §8.5).

    Integrity comes from the real zkPassport SNARK in `zkpassport_proof`
    (bound in-circuit to `agent_key`); the broker re-verifies it. No separate
    signature wraps the bundle. Canonical-JSON-encoded form of this object is
    the input to `delegation_hash = SHA-256(canonical_json(token))`.
    """

    model_config = ConfigDict(extra="forbid")

    version: Literal[1] = 1
    zkpassport_proof: str
    domain: Literal["hearme.network"] = "hearme.network"
    scope: Literal["v1"] = "v1"
    unique_identifier: str
    disclosed_predicates: dict[str, str]
    agent_key: str
    issued_at: datetime
    expires_at: datetime


class Envelope(BaseModel):
    """POST /v1/envelopes body (ARCHITECTURE.md §8.5).

    These are the **only** five fields that go over the wire. Boundary-leakage
    test in the e2e suite asserts this exact field set.
    """

    model_config = ConfigDict(extra="forbid")

    question_id: str
    answer: str
    nonce: str
    delegation_token: DelegationToken
    agent_signature: str


class Answer(BaseModel):
    """Internal Answerer result.

    `rationale` is local-only — it MUST NOT be serialized into the envelope.
    The Envelope layer pulls only `text` out.
    """

    model_config = ConfigDict(extra="forbid")

    text: str
    rationale: str = Field(
        default="",
        description="Local audit-trail rationale. NEVER cross the broker boundary.",
    )


class PersonaProjection(BaseModel):
    """Minimal sanitized projection from memory (ARCHITECTURE.md §7.3).

    No raw memory IDs, no source quotes, no demographic fields. Demographics
    live in the DelegationToken, not here.
    """

    model_config = ConfigDict(extra="forbid")

    topic: str | None
    relevant_facts: list[str]
    style_hints: list[str] = Field(default_factory=list)


class Decision(BaseModel):
    """Output of the Policy layer."""

    model_config = ConfigDict(extra="forbid")

    action: Literal["answer", "decline", "prompt_user"]
    reason: str = ""
