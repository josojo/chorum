"""POST /v1/envelopes — verify and persist (ARCHITECTURE.md §5).

Per-envelope pipeline. NO Self proof, NO bridge call at answer time — the
proof was verified once at registration and the broker issued the signed
DelegationToken the agent replays here.

  1. Parse with Pydantic (FastAPI does this).
  2. Verify the broker's OWN signature on the token + expiry (verify_delegation).
  3. Registry: the registrations row for unique_identifier must exist, bind the
     SAME agent_key, and not be revoked. Also honor the legacy revocations table
     (by delegation_hash).
  4. Recompute delegation_hash (done in verify_delegation) — it's the value the
     agent_signature is checked against, so tampering the token breaks step 5.
  5. Verify agent_signature over H(question_id || answer || nonce || delegation_hash).
  6. Question exists, status='open', closes_at > now(), nonce matches, predicates
     eligible for the question scope.
  7. INSERT envelope (UNIQUE constraint = duplicate rejection).
  8. Increment the aggregate row.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter

from ..config import get_settings
from ..db import get_pool
from ..db import queries as q
from ..eligibility import is_scope_eligible
from ..models.schemas import Envelope, EnvelopeAck, RejectionReason
from ..verify import VerifyEnvelopeError, verify_agent_signature
from ..verify.delegation import VerifyDelegationError, verify_delegation

log = logging.getLogger("hearme_broker.envelopes")

router = APIRouter(prefix="/v1", tags=["envelopes"])


def _ack(accepted: bool, reason: RejectionReason | None = None) -> EnvelopeAck:
    settings = get_settings()
    if not accepted and not settings.expose_rejection_reasons:
        return EnvelopeAck(accepted=False, reason=None)
    return EnvelopeAck(accepted=accepted, reason=reason)


@router.post("/envelopes", response_model=EnvelopeAck)
async def submit_envelope(envelope: Envelope) -> EnvelopeAck:
    # Steps 2 & 4: broker-signature + expiry (synchronous; no bridge).
    try:
        verified = verify_delegation(envelope.delegation_token)
    except VerifyDelegationError as exc:
        log.info("delegation verify failed: %s", exc)
        return _ack(False, exc.reason)

    token = verified.token
    pool = get_pool()
    async with pool.acquire() as conn:
        # Step 3a: legacy revocation list (by delegation_hash).
        if await q.is_revoked(conn, verified.delegation_hash):
            return _ack(False, RejectionReason.TOKEN_REVOKED)

        # Step 3b: the identity must be a live registration bound to THIS
        # agent_key. (Registration happened once at /v1/register.)
        registration = await q.get_registration(conn, verified.unique_identifier)
        if registration is None:
            return _ack(False, RejectionReason.REGISTRATION_NOT_FOUND)
        if registration["revoked_at"] is not None:
            return _ack(False, RejectionReason.TOKEN_REVOKED)
        if registration["agent_key"] != token.agent_key:
            # Old token after a re-registration under a different agent_key.
            return _ack(False, RejectionReason.REGISTRATION_AGENT_MISMATCH)

        # Step 6a: question exists / open / not closed / nonce / eligibility.
        question = await q.get_question_for_verify(conn, envelope.question_id)
        if question is None:
            return _ack(False, RejectionReason.QUESTION_NOT_FOUND)
        if question["status"] != "open":
            return _ack(False, RejectionReason.QUESTION_NOT_OPEN)
        closes_at = question["closes_at"]
        now = datetime.now(timezone.utc)
        if closes_at.tzinfo is None:
            closes_at = closes_at.replace(tzinfo=timezone.utc)
        if closes_at <= now:
            return _ack(False, RejectionReason.QUESTION_CLOSED)
        if question["nonce"] != envelope.nonce:
            return _ack(False, RejectionReason.NONCE_MISMATCH)
        if not is_scope_eligible(
            question=question,
            disclosed_predicates=token.disclosed_predicates,
        ):
            return _ack(False, RejectionReason.SCOPE_INELIGIBLE)

        # Step 5: agent signature over the per-question payload.
        try:
            verify_agent_signature(
                agent_pubkey_base64=token.agent_key,
                question_id=envelope.question_id,
                answer=envelope.answer,
                nonce=envelope.nonce,
                delegation_hash_hex=verified.delegation_hash,
                agent_signature_base64=envelope.agent_signature,
            )
        except VerifyEnvelopeError as exc:
            log.info("envelope verify failed: %s", exc)
            return _ack(False, exc.reason)

        # Steps 7-8 in a transaction so aggregates can't drift from envelopes.
        async with conn.transaction():
            inserted = await q.insert_envelope(
                conn,
                question_id=envelope.question_id,
                unique_identifier=verified.unique_identifier,
                answer=envelope.answer,
                disclosed_predicates=token.disclosed_predicates,
                agent_signature=envelope.agent_signature,
                delegation_hash_hex=verified.delegation_hash,
            )
            if not inserted:
                # Composite PK collision — DB-enforced one-answer-per-human.
                return _ack(False, RejectionReason.DUPLICATE)
            await q.increment_aggregate(
                conn,
                question_id=envelope.question_id,
                disclosed_predicates=token.disclosed_predicates,
            )

        # STUB: honeypot signal handling — v0.2 (ARCHITECTURE.md §11).
        return _ack(True)
