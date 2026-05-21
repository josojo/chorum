"""POST /v1/register — verify-once enrollment (ARCHITECTURE.md §5/§8).

The registration pipeline, the only path that touches a Self proof:

  1. Parse the EnrollmentBundle (FastAPI/Pydantic).
  2. Verify every Self proof via the self-bridge (off-chain SNARK + one-time
     on-chain Celo registry/root check) and derive the bucketed predicates.
  3. Atomically bind nullifier -> agent_key in the registrations registry
     (rejects a different agent_key for an already-bound nullifier).
  4. Mint and return the broker-signed DelegationToken.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter

from ..config import get_settings
from ..db import get_pool
from ..db import queries as q
from ..models.schemas import EnrollmentBundle, RegisterAck, RejectionReason
from ..verify.credential import issue_delegation_token
from ..verify.self_identity import VerifyEnrollmentError, verify_enrollment

log = logging.getLogger("hearme_broker.register")

router = APIRouter(prefix="/v1", tags=["register"])

# DelegationToken TTL (independent of Self's ±1 day proof-freshness window —
# the proof is verified once, here, then never replayed).
TOKEN_TTL = timedelta(days=90)


def _ack(
    accepted: bool,
    *,
    token=None,
    reason: RejectionReason | None = None,
) -> RegisterAck:
    settings = get_settings()
    if not accepted and not settings.expose_rejection_reasons:
        return RegisterAck(accepted=False, reason=None)
    return RegisterAck(accepted=accepted, delegation_token=token, reason=reason)


@router.post("/register", response_model=RegisterAck)
async def register(bundle: EnrollmentBundle) -> RegisterAck:
    # Step 2: verify the Self proofs (bridge) + derive predicates.
    try:
        verified = await verify_enrollment(bundle)
    except VerifyEnrollmentError as exc:
        log.info("registration verify failed: %s", exc)
        return _ack(False, reason=exc.reason)

    now = datetime.now(timezone.utc)
    expires_at = now + TOKEN_TTL

    pool = get_pool()
    async with pool.acquire() as conn:
        if await q.is_self_nullifier_invalidated(conn, verified.unique_identifier):
            log.info(
                "identity revoked by Self: nullifier=%s…",
                verified.unique_identifier[:12],
            )
            return _ack(False, reason=RejectionReason.IDENTITY_REVOKED)

        # Step 3: atomic Sybil bind.
        status = await q.upsert_registration(
            conn,
            unique_identifier=verified.unique_identifier,
            agent_key=verified.agent_key,
            disclosed_predicates=verified.disclosed_predicates,
            issued_at=now,
            expires_at=expires_at,
        )
        if status is None:
            log.info(
                "identity already bound: nullifier=%s… new_agent=%s…",
                verified.unique_identifier[:12],
                verified.agent_key[:12],
            )
            return _ack(False, reason=RejectionReason.IDENTITY_ALREADY_BOUND)

    # Step 4: mint the broker-signed session credential.
    token = issue_delegation_token(
        unique_identifier=verified.unique_identifier,
        disclosed_predicates=verified.disclosed_predicates,
        agent_key=verified.agent_key,
        issued_at=now,
        expires_at=expires_at,
    )
    log.info(
        "registered nullifier=%s… status=%s band=%s region=%s",
        verified.unique_identifier[:12],
        status,
        verified.disclosed_predicates.get("age_band"),
        verified.disclosed_predicates.get("region"),
    )
    return _ack(True, token=token)
