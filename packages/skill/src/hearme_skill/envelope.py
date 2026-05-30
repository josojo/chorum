"""Envelope — § 7.5.

Builds the five-field POST body (ARCHITECTURE.md §8.5) and signs it with the
agent key. The signature covers
``H(question_id || answer || nonce || delegation_hash)`` so envelopes can't be
replayed against a different question (§1.9).

Also builds the per-answer **revocation** payload (§1.12 "override is sacred"):
``H("REVOKE" | question_id | delegation_hash)``. Domain-separated by the
``REVOKE`` prefix so a captured envelope signature cannot be replayed as a
revocation.
"""

from __future__ import annotations

import base64

from .crypto.canonical import revocation_payload, sign_payload
from .crypto.ed25519 import Keypair, sign
from .delegation import hash_of
from .models import DelegationToken, Envelope


def build_envelope(
    *,
    question_id: str,
    answer_text: str,
    nonce: str,
    delegation_token: DelegationToken,
    agent_key: Keypair,
) -> Envelope:
    """Construct + sign an envelope.

    Note the function takes `answer_text: str`, not `Answer`. This is on
    purpose: the local-only `Answer.rationale` field must never leak into
    the envelope. Callers extract `.text` themselves.
    """

    dhash_hex = hash_of(delegation_token).hex()
    payload = sign_payload(question_id, answer_text, nonce, dhash_hex)
    sig = sign(agent_key, payload)
    return Envelope(
        question_id=question_id,
        answer=answer_text,
        nonce=nonce,
        delegation_token=delegation_token,
        agent_signature=base64.b64encode(sig).decode("ascii"),
    )


def serialize_envelope(env: Envelope) -> dict:
    """Dict ready for `httpx.post(..., json=...)`. Five fields, no extras."""

    body = env.model_dump(mode="json")
    # Defensive check — the boundary-leakage test in §12 verifies this from
    # the wire side, but we also sanity-check here.
    expected = {"question_id", "answer", "nonce", "delegation_token", "agent_signature"}
    if set(body.keys()) != expected:
        raise RuntimeError(
            f"Envelope serialization carries unexpected keys: {set(body.keys()) ^ expected}"
        )
    return body


def build_revocation(
    *,
    question_id: str,
    delegation_token: DelegationToken,
    agent_key: Keypair,
) -> dict:
    """Build the three-field revocation POST body (§1.12).

    Returns a dict ready for ``httpx.post(..., json=...)``. No answer content,
    no rationale, no question text on the wire — the broker recovers the
    user's identity from ``delegation_token`` and the target answer from
    ``(question_id, delegation_token.unique_identifier)``. Boundary-leakage
    check: exactly three keys, no extras.
    """

    dhash_hex = hash_of(delegation_token).hex()
    sig = sign(agent_key, revocation_payload(question_id, dhash_hex))
    body = {
        "question_id": question_id,
        "delegation_token": delegation_token.model_dump(mode="json"),
        "revocation_signature": base64.b64encode(sig).decode("ascii"),
    }
    expected = {"question_id", "delegation_token", "revocation_signature"}
    if set(body.keys()) != expected:
        raise RuntimeError(
            f"Revocation serialization carries unexpected keys: {set(body.keys()) ^ expected}"
        )
    return body
