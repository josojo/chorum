"""POST /v1/envelopes — verify and persist.

Implements the verification pipeline from ARCHITECTURE.md §5 in order:

  1. Parse with Pydantic (FastAPI does this).
  2. Verify the zkPassport proof (real SNARK via the zkpassport-bridge) and its
     bindings: agent_key, scope, nullifier, predicates.
  3. Check token.expires_at > now().
  4. Check delegation_hash not in revocations.
  5. Recompute expected delegation_hash (we do this inside verify_delegation
     and pass the result forward — that recomputed hash IS the value the
     agent_signature is checked against, so any tampering of the embedded
     token would break step 6).
  6. Verify agent_signature over H(question_id || answer || nonce || delegation_hash).
  7. Check question_id exists, status='open', closes_at > now(), nonce matches,
     and the signed demographic predicates are eligible for the question scope.
  8. INSERT envelope (UNIQUE constraint = duplicate rejection).
  9. Increment aggregates row for question_id.
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
from ..verify import (
    VerifyEnvelopeError,
    verify_agent_signature,
)
from ..verify.delegation import VerifyDelegationError, verify_delegation

log = logging.getLogger("hearme_broker.envelopes")

router = APIRouter(prefix="/v1", tags=["envelopes"])


def _ack(accepted: bool, reason: RejectionReason | None = None) -> EnvelopeAck:
    settings = get_settings()
    if not accepted and not settings.expose_rejection_reasons:
        # Production posture: do not reveal which step failed.
        # STUB: still emits ``accepted=False`` but always with reason=None.
        return EnvelopeAck(accepted=False, reason=None)
    return EnvelopeAck(accepted=accepted, reason=reason)


@router.post("/envelopes", response_model=EnvelopeAck)
async def submit_envelope(envelope: Envelope) -> EnvelopeAck:
    # Step 1: parsing already happened (FastAPI ran Pydantic v2 with extra="forbid").

    # Steps 2 & 3 & 5 (and prep for 6). Async: real SNARK verification of the
    # zkPassport proof runs through the zkpassport-bridge.
    try:
        verified = await verify_delegation(envelope.delegation_token)
    except VerifyDelegationError as exc:
        log.info("delegation verify failed: %s", exc)
        return _ack(False, exc.reason)

    pool = get_pool()
    async with pool.acquire() as conn:
        # Step 4: revocation lookup.
        if await q.is_revoked(conn, verified.delegation_hash):
            return _ack(False, RejectionReason.TOKEN_REVOKED)

        # Steps 6 & 7 are interleaved: we must know the question's nonce to
        # confirm the agent signed the right one. But the cryptographic check
        # binds (question_id, answer, nonce, delegation_hash); a mismatched
        # nonce will already fail step 6. We additionally enforce a literal
        # nonce-equality check below for a clearer rejection reason.

        # Step 7a: question exists?
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
            disclosed_predicates=verified.token.disclosed_predicates,
        ):
            return _ack(False, RejectionReason.SCOPE_INELIGIBLE)

        # Step 6: agent signature.
        try:
            verify_agent_signature(
                agent_pubkey_base64=verified.token.agent_key,
                question_id=envelope.question_id,
                answer=envelope.answer,
                nonce=envelope.nonce,
                delegation_hash_hex=verified.delegation_hash,
                agent_signature_base64=envelope.agent_signature,
            )
        except VerifyEnvelopeError as exc:
            log.info("envelope verify failed: %s", exc)
            return _ack(False, exc.reason)

        # Steps 7-9 in a transaction so aggregates can't drift from envelopes
        # and the nullifier binding is persisted only when the envelope lands.
        async with conn.transaction():
            # Step 6b: identity binding. If this nullifier has been bound to a
            # *different* agent_key in the past, reject atomically inside the
            # transaction. The INSERT/ON CONFLICT lock in bind_nullifier_agent
            # closes the race where two first envelopes for the same nullifier
            # arrive under different agent keys.
            bound = await q.bind_nullifier_agent(
                conn,
                nullifier=verified.token.unique_identifier,
                agent_key=verified.token.agent_key,
            )
            if not bound:
                log.info(
                    "identity already bound: nullifier=%s new=%s",
                    verified.token.unique_identifier[:12] + "…",
                    verified.token.agent_key[:12] + "…",
                )
                return _ack(False, RejectionReason.IDENTITY_ALREADY_BOUND)

            inserted = await q.insert_envelope(
                conn,
                question_id=envelope.question_id,
                unique_identifier=verified.token.unique_identifier,
                answer=envelope.answer,
                disclosed_predicates=verified.token.disclosed_predicates,
                agent_signature=envelope.agent_signature,
                delegation_hash_hex=verified.delegation_hash,
            )
            if not inserted:
                # Composite PK collision — DB-enforced one-answer-per-human.
                return _ack(False, RejectionReason.DUPLICATE)
            await q.increment_aggregate(
                conn,
                question_id=envelope.question_id,
                disclosed_predicates=verified.token.disclosed_predicates,
            )

        # STUB: honeypot signal handling. v0 does no scoring on accepted
        # envelopes; v0.2 surfaces a per-user honeypot signal here
        # (ARCHITECTURE.md §11).
        return _ack(True)
