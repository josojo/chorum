"""Per-envelope DelegationToken verification (ARCHITECTURE.md §5).

This is the answer-time path. It does NOT touch a Self proof or the bridge —
the proof was verified once at registration. Steps here:

  1. Verify the broker's OWN signature on the token (integrity).
  2. Check ``expires_at > now()``.

The caller then does the DB-backed checks (registrations registry lookup:
agent_key matches + ``revoked_at IS NULL``; the legacy ``revocations`` table;
the agent's per-question signature; uniqueness) — see ``routes/envelopes.py``.
``delegation_hash`` (over the whole token, broker_signature included) is
computed here so the caller doesn't recompute it.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

from ..config import Settings, get_settings
from ..models.schemas import DelegationToken, RejectionReason
from .canonical import canonical_json, delegation_hash
from .credential import verify_broker_signature


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


def check_expiry(token: DelegationToken, *, now: datetime | None = None) -> None:
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


def verify_delegation(
    token: DelegationToken,
    *,
    now: datetime | None = None,
    settings: Settings | None = None,
) -> VerifiedDelegation:
    """Per-envelope token verification. Synchronous — no bridge, no proof.

    Returns a ``VerifiedDelegation`` carrying the canonical hash so the caller
    can do the registry/revocation lookups and the agent-signature check
    without recomputing.
    """
    settings = settings or get_settings()

    # Step 1: the token must be one THIS broker minted.
    if not verify_broker_signature(token, settings=settings):
        raise VerifyDelegationError(
            RejectionReason.BROKER_SIGNATURE_INVALID,
            "broker_signature does not verify against the broker key",
        )

    # Step 2: not expired.
    check_expiry(token, now=now)

    token_dict = token.model_dump(mode="json")
    return VerifiedDelegation(
        token=token,
        delegation_hash=delegation_hash(token_dict),
        canonical_bytes=canonical_json(token_dict),
        unique_identifier=token.unique_identifier,
        disclosed=token.disclosed_predicates,
    )
