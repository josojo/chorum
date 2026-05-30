"""Agent signature verification + request linkage.

ARCHITECTURE.md §8.5:
    agent_signature = Sign(agent_key, H(question_id || answer || nonce || delegation_hash))

The byte-level wire format of that input is not pinned by the spec. We pin it
here: the four components joined with a single ASCII ``|`` separator (which
cannot appear in a UUID, hex hash, or base64 nonce). That choice is mirrored
verbatim in ``hearme-skill`` (when that package is built) — both signers and
verifiers MUST agree.

Per-envelope override (§1.12): a user can retract one of their own answers by
signing a *revocation* — a different, domain-separated input:

    revocation_signature = Sign(agent_key, H("REVOKE" | question_id | delegation_hash))

The literal ``REVOKE`` prefix is the domain separator. It is structurally
impossible to confuse a revocation signature with an envelope signature, so
an attacker who captures one cannot replay it as the other.
"""

from __future__ import annotations

import base64
import hashlib
from uuid import UUID

from nacl.exceptions import BadSignatureError
from nacl.signing import VerifyKey

from ..models.schemas import RejectionReason


class VerifyEnvelopeError(Exception):
    def __init__(self, reason: RejectionReason, detail: str = "") -> None:
        super().__init__(f"{reason.value}: {detail}" if detail else reason.value)
        self.reason = reason
        self.detail = detail


SEP = b"|"


def envelope_signing_input(
    question_id: UUID | str,
    answer: str,
    nonce: str,
    delegation_hash_hex: str,
) -> bytes:
    """Return the exact bytes the agent_key signs.

    Two equal logical inputs must produce identical bytes; the agent and
    broker share this function (or its byte-for-byte equivalent in the skill).
    """
    qid = str(question_id).encode("utf-8")
    parts = [qid, answer.encode("utf-8"), nonce.encode("utf-8"), delegation_hash_hex.encode("utf-8")]
    raw = SEP.join(parts)
    # We hash first so the signed message is a fixed 32 bytes regardless of
    # answer length — matches ``H(question_id || answer || nonce || delegation_hash)``.
    return hashlib.sha256(raw).digest()


def verify_agent_signature(
    *,
    agent_pubkey_base64: str,
    question_id: UUID | str,
    answer: str,
    nonce: str,
    delegation_hash_hex: str,
    agent_signature_base64: str,
) -> None:
    """Raise ``VerifyEnvelopeError`` on any signature/key/linkage failure.

    Any swap of question_id/answer/nonce/delegation_hash changes the digest
    and forces this check to fail — that is the linkage guarantee the
    broker test suite exercises (ARCHITECTURE.md §12).
    """
    try:
        agent_pubkey = base64.b64decode(agent_pubkey_base64)
    except Exception as exc:  # noqa: BLE001
        raise VerifyEnvelopeError(
            RejectionReason.AGENT_KEY_INVALID, f"base64 decode failed: {exc}"
        ) from exc
    if len(agent_pubkey) != 32:
        raise VerifyEnvelopeError(
            RejectionReason.AGENT_KEY_INVALID,
            f"agent_key is {len(agent_pubkey)} bytes; want 32",
        )
    try:
        signature = base64.b64decode(agent_signature_base64)
    except Exception as exc:  # noqa: BLE001
        raise VerifyEnvelopeError(
            RejectionReason.AGENT_SIGNATURE_INVALID, f"base64 decode failed: {exc}"
        ) from exc
    if len(signature) != 64:
        raise VerifyEnvelopeError(
            RejectionReason.AGENT_SIGNATURE_INVALID,
            f"signature is {len(signature)} bytes; want 64",
        )

    vk = VerifyKey(agent_pubkey)
    digest = envelope_signing_input(question_id, answer, nonce, delegation_hash_hex)
    try:
        vk.verify(digest, signature)
    except BadSignatureError as exc:
        raise VerifyEnvelopeError(
            RejectionReason.AGENT_SIGNATURE_INVALID, "agent signature does not verify"
        ) from exc


REVOKE_DOMAIN = b"REVOKE"


def revocation_signing_input(
    question_id: UUID | str,
    delegation_hash_hex: str,
) -> bytes:
    """Return the exact bytes the agent_key signs to revoke ONE answer.

    Domain-separated from ``envelope_signing_input`` by the literal ``REVOKE``
    prefix, so a captured envelope signature cannot be replayed as a revocation
    and vice versa. Skill mirrors this byte-for-byte.
    """
    qid = str(question_id).encode("utf-8")
    parts = [REVOKE_DOMAIN, qid, delegation_hash_hex.encode("utf-8")]
    raw = SEP.join(parts)
    return hashlib.sha256(raw).digest()


def verify_revocation_signature(
    *,
    agent_pubkey_base64: str,
    question_id: UUID | str,
    delegation_hash_hex: str,
    revocation_signature_base64: str,
) -> None:
    """Raise ``VerifyEnvelopeError`` on any signature/key failure.

    Mirrors ``verify_agent_signature`` but over the revocation digest, so the
    same authentication guarantees apply: only the holder of the agent_key
    (which the broker has never seen the private half of) can produce a valid
    revocation. The reason codes reuse ``AGENT_*`` because semantically the
    failure mode is identical — bad/foreign agent_key, bad signature.
    """
    try:
        agent_pubkey = base64.b64decode(agent_pubkey_base64)
    except Exception as exc:  # noqa: BLE001
        raise VerifyEnvelopeError(
            RejectionReason.AGENT_KEY_INVALID, f"base64 decode failed: {exc}"
        ) from exc
    if len(agent_pubkey) != 32:
        raise VerifyEnvelopeError(
            RejectionReason.AGENT_KEY_INVALID,
            f"agent_key is {len(agent_pubkey)} bytes; want 32",
        )
    try:
        signature = base64.b64decode(revocation_signature_base64)
    except Exception as exc:  # noqa: BLE001
        raise VerifyEnvelopeError(
            RejectionReason.AGENT_SIGNATURE_INVALID, f"base64 decode failed: {exc}"
        ) from exc
    if len(signature) != 64:
        raise VerifyEnvelopeError(
            RejectionReason.AGENT_SIGNATURE_INVALID,
            f"signature is {len(signature)} bytes; want 64",
        )

    vk = VerifyKey(agent_pubkey)
    digest = revocation_signing_input(question_id, delegation_hash_hex)
    try:
        vk.verify(digest, signature)
    except BadSignatureError as exc:
        raise VerifyEnvelopeError(
            RejectionReason.AGENT_SIGNATURE_INVALID,
            "revocation signature does not verify",
        ) from exc
