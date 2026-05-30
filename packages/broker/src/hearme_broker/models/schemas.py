"""Pydantic models for the broker wire formats.

Mirror packages/proto/{self,enrollment,delegation,envelope,question}.json.
``extra="forbid"`` matches the boundary-leakage assertion in ARCHITECTURE.md
§12: an envelope body MUST contain exactly five top-level fields.

Identity model (verify-once — ARCHITECTURE.md §5/§8): the skill posts an
``EnrollmentBundle`` (Self proofs + agent_key) to ``POST /v1/register`` once;
the broker verifies the proofs and returns a broker-signed ``DelegationToken``
(the session credential) the agent replays in every ``Envelope``.
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class SelfProofBundle(BaseModel):
    """One verifiable Self proof (mirror packages/proto/self.json).

    Field aliases are the camelCase keys the Self app / bridge use; populate by
    either form. Re-serialize with ``by_alias=True`` when forwarding to the
    self-bridge ``POST /verify``.
    """

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    attestation_id: int = Field(alias="attestationId")
    proof: Any
    public_signals: list[Any] = Field(alias="publicSignals")
    user_context_data: str = Field(alias="userContextData")


class EnrollmentBundle(BaseModel):
    """POST /v1/register body (mirror packages/proto/enrollment.json).

    Install-only; never stored. The broker verifies every proof once, binds the
    nullifier, and returns a DelegationToken.
    """

    model_config = ConfigDict(extra="forbid")

    self_proofs: list[SelfProofBundle] = Field(min_length=1)
    agent_key: str = Field(description="base64 Ed25519 public key, 32 bytes")


class DelegationToken(BaseModel):
    """Broker-issued, broker-signed session credential (proto/delegation.json).

    Returned by ``POST /v1/register``; replayed by the agent in every envelope.
    Integrity is the broker's own signature over canonical_json(token minus
    ``broker_signature``). Canonical-JSON of the WHOLE object is the input to
    ``delegation_hash = SHA-256(canonical_json(token))``.
    """

    model_config = ConfigDict(extra="forbid")

    version: Literal[2]
    scope: Literal["hearme-v1"]
    unique_identifier: str = Field(
        description="Self nullifier (scope-bound, unique-per-user-per-scope)."
    )
    disclosed_predicates: dict[str, str]
    agent_key: str = Field(description="base64 Ed25519 public key, 32 bytes")
    issued_at: datetime
    expires_at: datetime
    broker_signature: str = Field(
        description="base64 Ed25519 signature by the broker over the token claims."
    )


class Envelope(BaseModel):
    """POST /v1/envelopes body. Exactly 5 fields — boundary-leakage check."""

    model_config = ConfigDict(extra="forbid")

    question_id: UUID
    answer: str
    nonce: str
    delegation_token: DelegationToken
    agent_signature: str = Field(description="base64 Ed25519 signature, 64 bytes")


class Question(BaseModel):
    """GET /v1/questions/open row."""

    model_config = ConfigDict(extra="forbid")

    question_id: UUID
    text: str
    topic: str | None = None
    options: list[str] = Field(min_length=2, max_length=8)
    created_at: datetime
    closes_at: datetime
    nonce: str


class PlatformStats(BaseModel):
    """GET /v1/stats — privacy-safe site-wide counts for the public stats page.

    Aggregate COUNTs only; the broker computes these because the web role is
    walled off from ``registrations`` and ``envelopes`` (db/init/02-roles.sh).
    ``avg_answers_per_question`` is over all questions (0 when none exist).
    """

    model_config = ConfigDict(extra="forbid")

    registered_agents: int
    questions: int
    total_answers: int
    respondents: int
    answered_questions: int
    avg_answers_per_question: float


class RejectionReason(str, Enum):
    """Specific reasons the broker rejects a registration or an envelope.

    Returned in the ack body when ``expose_rejection_reasons`` is True (v0
    default for debugging). Production should set this False so the broker
    is not a verification oracle (ARCHITECTURE.md §5).
    """

    SCHEMA_INVALID = "schema_invalid"
    INTERNAL_ERROR = "internal_error"

    # --- registration (POST /v1/register; verify/self_identity.py) ---
    ENROLLMENT_MALFORMED = "enrollment_malformed"
    SELF_PROOF_INVALID = "self_proof_invalid"
    SELF_PROOF_EXPIRED = "self_proof_expired"  # Self ±1 day window (InvalidTimestamp)
    SELF_BRIDGE_ERROR = "self_bridge_error"
    SELF_SCOPE_MISMATCH = "self_scope_mismatch"
    SELF_NULLIFIER_MISMATCH = "self_nullifier_mismatch"  # proofs disagree
    SELF_AGENT_BINDING_MISMATCH = "self_agent_binding_mismatch"
    SELF_REGISTRY_UNCONFIRMED = "self_registry_unconfirmed"  # on-chain root check
    PREDICATE_DERIVATION_FAILED = "predicate_derivation_failed"
    IDENTITY_ALREADY_BOUND = "identity_already_bound"  # nullifier→different agent_key
    IDENTITY_REVOKED = "identity_revoked"  # Self on-chain invalidation already seen

    # --- per envelope (POST /v1/envelopes) ---
    TOKEN_EXPIRED = "token_expired"
    TOKEN_REVOKED = "token_revoked"
    BROKER_SIGNATURE_INVALID = "broker_signature_invalid"
    REGISTRATION_NOT_FOUND = "registration_not_found"
    REGISTRATION_AGENT_MISMATCH = "registration_agent_mismatch"
    DELEGATION_HASH_MISMATCH = "delegation_hash_mismatch"
    AGENT_SIGNATURE_INVALID = "agent_signature_invalid"
    AGENT_KEY_INVALID = "agent_key_invalid"
    QUESTION_NOT_FOUND = "question_not_found"
    QUESTION_NOT_OPEN = "question_not_open"
    QUESTION_CLOSED = "question_closed"
    NONCE_MISMATCH = "nonce_mismatch"
    SCOPE_INELIGIBLE = "scope_ineligible"
    DUPLICATE = "duplicate"

    # --- per-envelope override (POST /v1/envelopes/revoke; §1.12) ---
    ENVELOPE_NOT_FOUND = "envelope_not_found"  # nothing to revoke (idempotent ack)


class EnvelopeAck(BaseModel):
    """Response to POST /v1/envelopes."""

    model_config = ConfigDict(extra="forbid")

    accepted: bool
    reason: RejectionReason | None = None


class EnvelopeRevocation(BaseModel):
    """POST /v1/envelopes/revoke body.

    The user retracts their own previously-submitted answer for one question
    (§1.12 "override is sacred"). Authenticated by an Ed25519 signature over
    a domain-separated digest the broker recomputes from the request fields
    (see ``verify/envelope.py::revocation_signing_input``).

    Exactly 3 fields — boundary-leakage check (no answer content, no rationale,
    no question text — the broker recovers the unique_identifier from the
    delegation token, so the wire never carries demographic data either).
    """

    model_config = ConfigDict(extra="forbid")

    question_id: UUID
    delegation_token: DelegationToken
    revocation_signature: str = Field(
        description="base64 Ed25519 signature (64 bytes) over "
        "H('REVOKE' | question_id | delegation_hash)."
    )


class RevocationAck(BaseModel):
    """Response to POST /v1/envelopes/revoke.

    ``accepted`` is True both when an envelope was actually deleted and when
    none existed (idempotent — a second revoke of the same answer is a no-op,
    not an error). ``found`` distinguishes the two for the agent's local UI;
    it is omitted entirely in production when ``expose_rejection_reasons`` is
    False, so the response carries no signal beyond accepted/rejected.
    """

    model_config = ConfigDict(extra="forbid")

    accepted: bool
    found: bool | None = None
    reason: RejectionReason | None = None


class RegisterAck(BaseModel):
    """Response to POST /v1/register.

    On success, ``delegation_token`` is the broker-signed session credential the
    agent stores and replays per answer.
    """

    model_config = ConfigDict(extra="forbid")

    accepted: bool
    delegation_token: DelegationToken | None = None
    reason: RejectionReason | None = None
