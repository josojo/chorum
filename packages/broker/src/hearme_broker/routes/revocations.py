"""POST /v1/envelopes/revoke — per-answer override (§1.12 "override is sacred").

A user retracts ONE of their own envelopes for ONE question. The broker:

  1. Verifies the broker's own signature on the delegation_token + expiry — the
     SAME check the envelope path runs (see ``verify/delegation.py``). The
     token is the only thing that identifies the user; we don't accept any
     ``unique_identifier`` on the wire.
  2. Honors the legacy revocation list (delegation_hash) and the
     ``registrations`` registry — a revoked or unbound token cannot retract.
     (Otherwise stale tokens could be replayed to delete current answers.)
  3. Verifies the user's Ed25519 signature over the *revocation* digest —
     domain-separated from the envelope digest by the ``REVOKE`` prefix
     (``verify/envelope.py::revocation_signing_input``). Only the holder of
     the agent_key (private half lives on the user's device, never the broker)
     can produce this.
  4. Atomically DELETEs the envelope for ``(question_id, token.unique_identifier)``
     and rebuilds the question's aggregate from the remaining envelopes.

Idempotent: revoking an already-revoked or never-submitted answer returns
``accepted=True, found=False``. The endpoint never tells callers *whether*
an answer existed when ``expose_rejection_reasons`` is off — same posture as
the envelope path, so the broker is not a "did this user vote?" oracle.

Wire format is exactly three fields (``question_id``, ``delegation_token``,
``revocation_signature``) — extra fields are rejected by Pydantic
(``extra="forbid"``), matching the §12 boundary-leakage assertion. Answer
content does not appear on the revocation wire.

NOTE on the question close window: revocation is permitted *regardless* of
``questions.status`` / ``closes_at``. §1.12 makes user override sacred — it
must not stop working when a question closes, otherwise the close becomes a
deadline against the user's own correction. (The dispatch path keeps using
``closes_at > now()`` to stop accepting new envelopes; that's untouched.)
"""

from __future__ import annotations

import logging

from fastapi import APIRouter

from ..config import get_settings
from ..db import get_pool
from ..db import queries as q
from ..models.schemas import EnvelopeRevocation, RejectionReason, RevocationAck
from ..verify import VerifyEnvelopeError
from ..verify.delegation import VerifyDelegationError, verify_delegation
from ..verify.envelope import verify_revocation_signature

log = logging.getLogger("hearme_broker.revocations")

router = APIRouter(prefix="/v1", tags=["envelopes"])


def _ack(
    accepted: bool,
    reason: RejectionReason | None = None,
    found: bool | None = None,
) -> RevocationAck:
    settings = get_settings()
    if not settings.expose_rejection_reasons:
        # Production posture: never tell callers whether an answer existed,
        # and never expose a specific rejection reason.
        return RevocationAck(accepted=accepted, reason=None, found=None)
    return RevocationAck(accepted=accepted, reason=reason, found=found)


@router.post("/envelopes/revoke", response_model=RevocationAck)
async def revoke_envelope(revocation: EnvelopeRevocation) -> RevocationAck:
    # Step 1 + 2a: broker-signature + expiry (synchronous, no bridge call).
    try:
        verified = verify_delegation(revocation.delegation_token)
    except VerifyDelegationError as exc:
        log.info("revocation: delegation verify failed: %s", exc)
        return _ack(False, exc.reason)

    token = verified.token
    pool = get_pool()
    async with pool.acquire() as conn:
        # Step 2b: legacy revocation list (by delegation_hash) — a revoked
        # token cannot revoke. Otherwise an attacker who captured an old
        # token could replay it to silence the user's *current* answers.
        if await q.is_revoked(conn, verified.delegation_hash):
            return _ack(False, RejectionReason.TOKEN_REVOKED)

        # Step 2c: live registration bound to THIS agent_key.
        registration = await q.get_registration(conn, verified.unique_identifier)
        if registration is None:
            return _ack(False, RejectionReason.REGISTRATION_NOT_FOUND)
        if registration["revoked_at"] is not None:
            return _ack(False, RejectionReason.TOKEN_REVOKED)
        if registration["agent_key"] != token.agent_key:
            return _ack(False, RejectionReason.REGISTRATION_AGENT_MISMATCH)

        # Step 3: the user's signature over the revocation digest. Only the
        # holder of the agent_key (private half never seen by the broker) can
        # produce this; domain-separated by the ``REVOKE`` prefix so a captured
        # envelope signature can't be replayed here.
        try:
            verify_revocation_signature(
                agent_pubkey_base64=token.agent_key,
                question_id=revocation.question_id,
                delegation_hash_hex=verified.delegation_hash,
                revocation_signature_base64=revocation.revocation_signature,
            )
        except VerifyEnvelopeError as exc:
            log.info("revocation: signature verify failed: %s", exc)
            return _ack(False, exc.reason)

        # Step 4: delete the envelope and rebuild this question's aggregate
        # in the same transaction. Idempotent — `found=False` if nothing
        # matched, but ``accepted`` is still True (a no-op is success).
        found = await q.delete_one_envelope_and_recompute(
            conn,
            question_id=revocation.question_id,
            unique_identifier=verified.unique_identifier,
        )

    log.info(
        "revocation: question_id=%s found=%s",
        revocation.question_id,
        found,
    )
    return _ack(True, None if found else RejectionReason.ENVELOPE_NOT_FOUND, found)
