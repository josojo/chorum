"""ZK passport identity forwarding (skill side).

The phone is responsible for producing the cryptographic material; the
skill's job is to receive an identity bundle (a ``DelegationToken``
containing a structured ``ZkPassportProof`` in ``zkpassport_proof``), do
the cheap structural checks the skill can do without the broker's issuer
registry, and store the bundle on disk for use by the envelope layer.

The skill DELIBERATELY does NOT verify the issuer signature here:

* The skill doesn't ship the issuer pubkey registry.
* The broker is the source of truth for what counts as a valid identity
  and will reject any envelope whose proof fails verification, surfacing
  a clear rejection reason.
* Keeping the skill's surface narrow matches §1.13 (phone is enrollment-only)
  and avoids two divergent issuer registries.

The skill DOES check:

* The proof parses.
* ``proof.nullifier == token.unique_identifier``.
* ``proof.scope == "<token.domain>|<token.scope>"``.
* ``proof.agent_key_commitment`` matches ``SHA256(token.agent_key)``.
* ``proof.disclosed == token.disclosed_predicates`` (no silent drift after
  the phone signed).

These are cheap and catch user-error / wrong-bundle scenarios fast.
"""

from __future__ import annotations

import base64
import hashlib
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .crypto.canonical import canonical_json_bytes
from .models import DelegationToken


class ZkPassportProof(BaseModel):
    """Mirror of broker's ZkPassportProof. Parsed locally for structural checks."""

    model_config = ConfigDict(extra="forbid")

    version: Literal[1]
    scheme: str
    issuer_key_id: str
    scope: str
    nullifier: str
    agent_key_commitment: str
    predicate_commitment: str
    disclosed: dict[str, str]
    issued_at: datetime
    expires_at: datetime
    issuer_signature: str = Field(description="base64 Ed25519 signature, 64 bytes")


class IdentityBundleError(ValueError):
    """Raised when an incoming identity bundle doesn't structurally bind to
    the agent_key / scope / predicates already in the delegation token."""


def parse_proof_from_token(token: DelegationToken) -> ZkPassportProof:
    """Decode ``token.zkpassport_proof`` (base64 of canonical JSON) and parse."""
    try:
        raw = base64.b64decode(token.zkpassport_proof, validate=True)
    except Exception as exc:  # noqa: BLE001
        raise IdentityBundleError(
            f"zkpassport_proof base64 decode failed: {exc}"
        ) from exc
    try:
        return ZkPassportProof.model_validate_json(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValidationError) as exc:
        raise IdentityBundleError(f"zkpassport_proof parse failed: {exc}") from exc


def verify_bindings(token: DelegationToken) -> ZkPassportProof:
    """Structural binding checks. Returns the parsed proof on success.

    Does NOT verify ``issuer_signature`` — that's the broker's job
    (cf. module docstring).
    """
    proof = parse_proof_from_token(token)

    expected_scope = f"{token.domain}|{token.scope}"
    if proof.scope != expected_scope:
        raise IdentityBundleError(
            f"proof.scope={proof.scope!r} does not match token scope {expected_scope!r}"
        )

    if proof.nullifier != token.unique_identifier:
        raise IdentityBundleError(
            "proof.nullifier does not equal token.unique_identifier"
        )

    try:
        agent_raw = base64.b64decode(token.agent_key, validate=True)
    except Exception as exc:  # noqa: BLE001
        raise IdentityBundleError(f"token.agent_key base64 decode failed: {exc}") from exc
    expected_commit = hashlib.sha256(agent_raw).hexdigest()
    if proof.agent_key_commitment.lower() != expected_commit:
        raise IdentityBundleError(
            "agent_key_commitment does not match SHA256(token.agent_key)"
        )

    expected_pred_commit = hashlib.sha256(
        canonical_json_bytes(token.disclosed_predicates)
    ).hexdigest()
    if proof.predicate_commitment.lower() != expected_pred_commit:
        raise IdentityBundleError(
            "predicate_commitment does not match SHA256(canonical_json(predicates))"
        )
    if proof.disclosed != token.disclosed_predicates:
        raise IdentityBundleError(
            "proof.disclosed differs from token.disclosed_predicates"
        )
    return proof
