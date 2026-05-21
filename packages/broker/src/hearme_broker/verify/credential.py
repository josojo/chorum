"""Broker-issued session credential (the DelegationToken).

Verify-once (ARCHITECTURE.md §5/§8): after the broker verifies the Self proofs
at ``POST /v1/register``, it mints a ``DelegationToken`` signed by its own
Ed25519 key. The agent replays that token per answer; the broker verifies its
OWN signature — no Self proof, no bridge call at answer time.

The signed message is ``SHA-256(canonical_json(token claims without
broker_signature))``. ``issue`` and ``verify_broker_signature`` build that claims
dict the same way (deterministic ISO-8601 'Z' datetimes), so they always agree.
"""

from __future__ import annotations

import base64
import hashlib
from datetime import datetime, timezone
from typing import Any

from nacl.exceptions import BadSignatureError
from nacl.signing import SigningKey

from ..config import Settings, get_settings
from ..models.schemas import DelegationToken
from .canonical import canonical_json

SCOPE = "hearme-v1"


def _load_signing_key(settings: Settings) -> SigningKey:
    try:
        seed = base64.b64decode(settings.broker_signing_key, validate=True)
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"HEARME_BROKER_SIGNING_KEY is not valid base64: {exc}") from exc
    if len(seed) != 32:
        raise ValueError(
            f"HEARME_BROKER_SIGNING_KEY decodes to {len(seed)} bytes; want 32"
        )
    return SigningKey(seed)


def _iso(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _claims(
    *,
    unique_identifier: str,
    disclosed_predicates: dict[str, str],
    agent_key: str,
    issued_at: datetime,
    expires_at: datetime,
) -> dict[str, Any]:
    """Token claims WITHOUT broker_signature — the signed payload's source."""
    return {
        "version": 2,
        "scope": SCOPE,
        "unique_identifier": unique_identifier,
        "disclosed_predicates": disclosed_predicates,
        "agent_key": agent_key,
        "issued_at": _iso(issued_at),
        "expires_at": _iso(expires_at),
    }


def _payload(claims: dict[str, Any]) -> bytes:
    return hashlib.sha256(canonical_json(claims)).digest()


def issue_delegation_token(
    *,
    unique_identifier: str,
    disclosed_predicates: dict[str, str],
    agent_key: str,
    issued_at: datetime,
    expires_at: datetime,
    settings: Settings | None = None,
) -> DelegationToken:
    """Mint and sign a DelegationToken for a freshly verified identity."""
    settings = settings or get_settings()
    sk = _load_signing_key(settings)
    claims = _claims(
        unique_identifier=unique_identifier,
        disclosed_predicates=disclosed_predicates,
        agent_key=agent_key,
        issued_at=issued_at,
        expires_at=expires_at,
    )
    sig = sk.sign(_payload(claims)).signature
    return DelegationToken.model_validate(
        {**claims, "broker_signature": base64.b64encode(sig).decode("ascii")}
    )


def verify_broker_signature(
    token: DelegationToken, *, settings: Settings | None = None
) -> bool:
    """True iff ``token.broker_signature`` is a valid signature by THIS broker."""
    settings = settings or get_settings()
    sk = _load_signing_key(settings)
    claims = _claims(
        unique_identifier=token.unique_identifier,
        disclosed_predicates=token.disclosed_predicates,
        agent_key=token.agent_key,
        issued_at=token.issued_at,
        expires_at=token.expires_at,
    )
    try:
        sig = base64.b64decode(token.broker_signature, validate=True)
    except Exception:  # noqa: BLE001
        return False
    try:
        sk.verify_key.verify(_payload(claims), sig)
        return True
    except BadSignatureError:
        return False
