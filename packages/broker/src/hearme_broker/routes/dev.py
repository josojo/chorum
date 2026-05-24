"""DANGER — testing-only registration bypass.

Mounted by ``main.create_app`` **only** when
``HEARME_BROKER_DEV_INSECURE_REGISTER=1``. It mints a broker-signed
DelegationToken for a SYNTHETIC identity without any Self proof or bridge
verification, so the full answer→aggregate pipeline can be exercised end-to-end
without a phone (e.g. to populate aggregates with many identities).

This completely defeats proof-of-personhood and Sybil resistance — the entire
point of ``/v1/register``. It must NEVER be enabled in production. The real
registration path (``routes/register.py``) is untouched.
"""

from __future__ import annotations

import base64
import logging
import os
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field

from ..db import get_pool
from ..db import queries as q
from ..models.schemas import RegisterAck, RejectionReason
from ..verify.credential import issue_delegation_token
from ..verify.predicates import PredicateError, derive_predicates

log = logging.getLogger("hearme_broker.dev")

router = APIRouter(prefix="/v1/dev", tags=["dev"])

TOKEN_TTL = timedelta(days=90)


class DevRegisterRequest(BaseModel):
    """Synthetic-identity spec for the testing bypass."""

    model_config = ConfigDict(extra="forbid")

    agent_key: str = Field(description="base64 Ed25519 public key, 32 bytes")
    # Optional: a stable synthetic nullifier. Random per call when omitted.
    unique_identifier: str | None = None
    # Predicates are derived the authoritative way (same as the real path) from a
    # nationality + satisfied age thresholds, so aggregates look realistic.
    nationality: str = Field(default="US", description="ISO-3166 alpha-2.")
    satisfied_thresholds: list[int] = Field(default_factory=lambda: [18])


@router.post("/register", response_model=RegisterAck)
async def dev_register(req: DevRegisterRequest) -> RegisterAck:
    log.warning(
        "DEV INSECURE REGISTER used (no Self proof) nat=%s thresholds=%s",
        req.nationality,
        req.satisfied_thresholds,
    )

    # agent_key must be a usable 32-byte Ed25519 public key (matches the real path).
    try:
        if len(base64.b64decode(req.agent_key, validate=True)) != 32:
            raise ValueError("not 32 bytes")
    except Exception:  # noqa: BLE001
        return RegisterAck(accepted=False, reason=RejectionReason.ENROLLMENT_MALFORMED)

    try:
        predicates = derive_predicates(
            nationality=req.nationality, satisfied_thresholds=req.satisfied_thresholds
        )
    except PredicateError:
        return RegisterAck(accepted=False, reason=RejectionReason.PREDICATE_DERIVATION_FAILED)

    nullifier = req.unique_identifier or base64.b64encode(os.urandom(32)).decode("ascii")
    now = datetime.now(timezone.utc)
    expires_at = now + TOKEN_TTL

    pool = get_pool()
    async with pool.acquire() as conn:
        status = await q.upsert_registration(
            conn,
            unique_identifier=nullifier,
            agent_key=req.agent_key,
            disclosed_predicates=predicates,
            issued_at=now,
            expires_at=expires_at,
        )
    if status is None:
        return RegisterAck(accepted=False, reason=RejectionReason.IDENTITY_ALREADY_BOUND)

    token = issue_delegation_token(
        unique_identifier=nullifier,
        disclosed_predicates=predicates,
        agent_key=req.agent_key,
        issued_at=now,
        expires_at=expires_at,
    )
    return RegisterAck(accepted=True, delegation_token=token)
