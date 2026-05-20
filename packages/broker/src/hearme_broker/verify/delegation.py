"""DelegationToken verification.

Steps (ARCHITECTURE.md §5 + IDENTITY.md, in order):
  1. Check ``expires_at > now()``.
  2. Verify the zkPassport bundle in ``zkpassport_proof`` — real SNARK
     verification via the bridge, plus the agent_key / scope / nullifier /
     predicate bindings (see ``verify/zkpassport.py``).
  3. Check ``delegation_hash`` not in ``revocations`` table (caller checks DB).
  4. Check ``(nullifier, agent_key)`` binding in ``nullifiers`` table
     (caller checks DB).

This module handles 1 and 2, and computes the canonical hash callers need for
the revocation lookup and the agent-signature step. There is no phone
signature: integrity comes from the SNARK, which binds the agent_key in-circuit.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from ..config import Settings
from ..models.schemas import DelegationToken, RejectionReason
from .canonical import canonical_json, delegation_hash
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
    unique_identifier: str
    disclosed: dict[str, str]


def _token_to_dict(token: DelegationToken) -> dict:
    # mode="json" serializes datetimes as ISO strings, matching what the agent
    # hashed; ``canonical_json`` sorts keys before serialization.
    return token.model_dump(mode="json")


def check_expiry(token: DelegationToken, *, now: datetime | None = None) -> None:
    """Step 1: not expired."""
    moment = now or datetime.now(timezone.utc)
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


async def verify_delegation(
    token: DelegationToken,
    *,
    now: datetime | None = None,
    settings: Settings | None = None,
) -> VerifiedDelegation:
    """Run the pre-DB portion of the delegation pipeline.

    Returns a ``VerifiedDelegation`` carrying the canonical hash so the caller
    can do the revocations DB lookup and the agent-signature check without
    recomputing. Async because the SNARK verification calls the bridge.
    """
    check_expiry(token, now=now)
    try:
        verified_zk = await verify_zkpassport_proof(token, settings=settings)
    except VerifyZkPassportError as exc:
        # Surface the ZK rejection reason through the delegation exception type
        # so the envelope route keeps its single ``except`` block.
        raise VerifyDelegationError(exc.reason, exc.detail) from exc

    token_dict = _token_to_dict(token)
    return VerifiedDelegation(
        token=token,
        delegation_hash=delegation_hash(token_dict),
        canonical_bytes=canonical_json(token_dict),
        unique_identifier=verified_zk.unique_identifier,
        disclosed=verified_zk.disclosed,
    )
