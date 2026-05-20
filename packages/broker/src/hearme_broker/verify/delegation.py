"""DelegationToken verification.

Steps (ARCHITECTURE.md §5 + IDENTITY.md, in order):
  1. Verify ``phone_signature`` on the token bundle (Ed25519, well-known key).
  2. Check ``expires_at > now()``.
  3. Verify the embedded ZkPassportProof — issuer signature, scope binding,
     nullifier == unique_identifier, agent_key commitment, predicate
     commitment, and proof expiry (see ``verify/zkpassport.py``).
  4. Check ``delegation_hash`` not in ``revocations`` table (caller checks DB).
  5. Check ``(nullifier, agent_key)`` binding in ``nullifiers`` table
     (caller checks DB).

This module handles 1, 2, and 3, and computes the canonical hash callers
need for the revocation lookup and the agent-signature step.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass
from datetime import datetime, timezone

from nacl.exceptions import BadSignatureError
from nacl.signing import VerifyKey

from ..models.schemas import DelegationToken, RejectionReason, ZkPassportProof
from .canonical import canonical_json, delegation_hash
from .well_known import phone_verify_key
from .zkpassport import VerifyZkPassportError, verify_zkpassport_proof


class VerifyDelegationError(Exception):
    """Raised by ``verify_delegation`` when a check fails."""

    def __init__(self, reason: RejectionReason, detail: str = "") -> None:
        super().__init__(f"{reason.value}: {detail}" if detail else reason.value)
        self.reason = reason
        self.detail = detail


@dataclass(frozen=True)
class VerifiedDelegation:
    """The artifacts a caller needs after a token verifies."""

    token: DelegationToken
    delegation_hash: str
    canonical_bytes: bytes
    zk_proof: ZkPassportProof


def _token_payload_for_signature(token_dict: dict) -> bytes:
    """The bytes the phone signs: canonical JSON of the token with
    ``phone_signature`` removed.

    Matches packages/proto/delegation.json's description of phone_signature.
    """
    payload = {k: v for k, v in token_dict.items() if k != "phone_signature"}
    return canonical_json(payload)


def _token_to_dict(token: DelegationToken) -> dict:
    # Use mode="json" so datetimes serialize as ISO strings — matches what the
    # phone signed and what the agent recomputed. ``canonical_json`` will sort
    # keys before serialization.
    return token.model_dump(mode="json")


def verify_phone_signature(
    token: DelegationToken,
    *,
    verify_key: VerifyKey | None = None,
) -> None:
    """Step 1: phone signed the bundle."""
    vk = verify_key or phone_verify_key()
    token_dict = _token_to_dict(token)
    try:
        signature = base64.b64decode(token.phone_signature)
    except Exception as exc:  # noqa: BLE001
        raise VerifyDelegationError(
            RejectionReason.PHONE_SIGNATURE_INVALID, f"base64 decode failed: {exc}"
        ) from exc
    if len(signature) != 64:
        raise VerifyDelegationError(
            RejectionReason.PHONE_SIGNATURE_INVALID,
            f"signature is {len(signature)} bytes; want 64",
        )
    try:
        vk.verify(_token_payload_for_signature(token_dict), signature)
    except BadSignatureError as exc:
        raise VerifyDelegationError(
            RejectionReason.PHONE_SIGNATURE_INVALID, "phone signature does not verify"
        ) from exc


def check_expiry(token: DelegationToken, *, now: datetime | None = None) -> None:
    """Step 2: not expired."""
    moment = now or datetime.now(timezone.utc)
    # Pydantic gives us a tz-aware datetime; coerce naive ``now`` if a caller passes one.
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    expires_at = token.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at <= moment:
        raise VerifyDelegationError(
            RejectionReason.TOKEN_EXPIRED,
            f"expires_at={expires_at.isoformat()} now={moment.isoformat()}",
        )


def verify_delegation(
    token: DelegationToken,
    *,
    now: datetime | None = None,
    verify_key: VerifyKey | None = None,
) -> VerifiedDelegation:
    """Run the pre-DB portion of the delegation pipeline.

    Returns a ``VerifiedDelegation`` carrying the canonical hash so the
    caller can do the revocations DB lookup and the agent-signature check
    without recomputing.

    v0.2: The embedded ``zkpassport_proof`` is now cryptographically verified
    (issuer signature + four bindings: scope, nullifier, agent_key,
    predicates). v0.3 swaps the issuer-signature check for SNARK
    verification against ICAO CSCA pubkeys — see ``verify/zkpassport.py``.
    """
    verify_phone_signature(token, verify_key=verify_key)
    check_expiry(token, now=now)
    try:
        verified_zk = verify_zkpassport_proof(token, now=now)
    except VerifyZkPassportError as exc:
        # Surface the ZK rejection reason through the same exception type
        # used for the rest of the delegation pipeline so the envelope
        # route can keep its single ``except`` block.
        raise VerifyDelegationError(exc.reason, exc.detail) from exc

    token_dict = _token_to_dict(token)
    return VerifiedDelegation(
        token=token,
        delegation_hash=delegation_hash(token_dict),
        canonical_bytes=canonical_json(token_dict),
        zk_proof=verified_zk.proof,
    )
