"""ZK passport proof verification.

v0.2 cryptographic-but-not-circuit-grade verification of the
``ZkPassportProof`` embedded in ``DelegationToken.zkpassport_proof``.
A real production implementation replaces ``verify_issuer_signature`` with
SNARK verification against ICAO CSCA pubkeys — the surrounding bindings
(scope, nullifier, agent_key, predicates) carry over unchanged.

Checks (all must pass; first failure raises ``VerifyZkPassportError``):

  1. ``zkpassport_proof`` is base64 of canonical-JSON of a
     ``ZkPassportProof`` object (parses cleanly).
  2. ``issuer_key_id`` is in the well-known issuer registry.
  3. ``issuer_signature`` is a valid Ed25519 signature over the canonical
     JSON of the proof with ``issuer_signature`` removed.
  4. ``proof.scope == "<token.domain>|<token.scope>"`` (e.g.
     ``"hearme.network|v1"``).
  5. ``proof.nullifier == token.unique_identifier`` (byte-for-byte).
  6. ``proof.agent_key_commitment == SHA256(base64decode(token.agent_key))``
     in hex.
  7. ``proof.predicate_commitment == SHA256(canonical_json(
     token.disclosed_predicates))`` in hex, AND
     ``proof.disclosed == token.disclosed_predicates`` exactly.
  8. ``proof.expires_at >= token.expires_at`` (so a fresh delegation can
     never outlast its proof) and ``proof.expires_at > now()``.

Any swap — disclosed predicates after issuance, attempt to reuse a captured
proof with a different agent_key, scope swap — fails because the corresponding
binding's commitment or the issuer signature breaks.
"""

from __future__ import annotations

import base64
import hashlib
from dataclasses import dataclass
from datetime import datetime, timezone

from nacl.exceptions import BadSignatureError
from nacl.signing import VerifyKey
from pydantic import ValidationError

from ..models.schemas import DelegationToken, RejectionReason, ZkPassportProof
from .canonical import canonical_json
from .well_known import zk_issuer_verify_key


class VerifyZkPassportError(Exception):
    """Raised by :func:`verify_zkpassport_proof` when a check fails."""

    def __init__(self, reason: RejectionReason, detail: str = "") -> None:
        super().__init__(f"{reason.value}: {detail}" if detail else reason.value)
        self.reason = reason
        self.detail = detail


@dataclass(frozen=True)
class VerifiedZkPassport:
    """The parsed proof — handed back to callers so they don't have to re-parse."""

    proof: ZkPassportProof


def _proof_payload_for_signature(proof_dict: dict) -> bytes:
    payload = {k: v for k, v in proof_dict.items() if k != "issuer_signature"}
    return canonical_json(payload)


def _parse_proof(b64_blob: str) -> ZkPassportProof:
    try:
        raw = base64.b64decode(b64_blob, validate=True)
    except Exception as exc:  # noqa: BLE001
        raise VerifyZkPassportError(
            RejectionReason.ZKPASSPORT_PROOF_MALFORMED,
            f"base64 decode failed: {exc}",
        ) from exc
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise VerifyZkPassportError(
            RejectionReason.ZKPASSPORT_PROOF_MALFORMED,
            f"utf-8 decode failed: {exc}",
        ) from exc
    try:
        return ZkPassportProof.model_validate_json(text)
    except ValidationError as exc:
        raise VerifyZkPassportError(
            RejectionReason.ZKPASSPORT_PROOF_MALFORMED,
            f"schema validation failed: {exc.errors()[:1]}",
        ) from exc


def _verify_issuer_signature(proof: ZkPassportProof) -> None:
    vk: VerifyKey | None = zk_issuer_verify_key(proof.issuer_key_id)
    if vk is None:
        raise VerifyZkPassportError(
            RejectionReason.ZKPASSPORT_ISSUER_UNKNOWN,
            f"issuer_key_id={proof.issuer_key_id!r} not in registry",
        )
    try:
        signature = base64.b64decode(proof.issuer_signature, validate=True)
    except Exception as exc:  # noqa: BLE001
        raise VerifyZkPassportError(
            RejectionReason.ZKPASSPORT_SIGNATURE_INVALID,
            f"base64 decode failed: {exc}",
        ) from exc
    if len(signature) != 64:
        raise VerifyZkPassportError(
            RejectionReason.ZKPASSPORT_SIGNATURE_INVALID,
            f"signature is {len(signature)} bytes; want 64",
        )
    payload = _proof_payload_for_signature(proof.model_dump(mode="json"))
    try:
        vk.verify(payload, signature)
    except BadSignatureError as exc:
        raise VerifyZkPassportError(
            RejectionReason.ZKPASSPORT_SIGNATURE_INVALID,
            "issuer signature does not verify",
        ) from exc


def _agent_key_commitment(agent_key_b64: str) -> str:
    try:
        raw = base64.b64decode(agent_key_b64, validate=True)
    except Exception:
        # The DelegationToken's agent_key shape is validated by Pydantic +
        # the envelope-route's separate agent-pubkey check, so we don't
        # double-attribute that failure here. Just return a value that
        # cannot match any valid commitment.
        return ""
    return hashlib.sha256(raw).hexdigest()


def _predicate_commitment(predicates: dict[str, str]) -> str:
    # Canonical JSON of the same dict the broker holds — sorts keys.
    return hashlib.sha256(canonical_json(predicates)).hexdigest()


def verify_zkpassport_proof(
    token: DelegationToken,
    *,
    now: datetime | None = None,
) -> VerifiedZkPassport:
    """Run the full proof-verification pipeline.

    Returns the parsed proof so callers can read e.g. ``proof.disclosed`` or
    ``proof.scheme`` without re-decoding.
    """
    proof = _parse_proof(token.zkpassport_proof)

    # Step 3: issuer signature.
    _verify_issuer_signature(proof)

    # Step 4: scope binds proof to (domain, scope).
    expected_scope = f"{token.domain}|{token.scope}"
    if proof.scope != expected_scope:
        raise VerifyZkPassportError(
            RejectionReason.ZKPASSPORT_SCOPE_MISMATCH,
            f"proof.scope={proof.scope!r} expected {expected_scope!r}",
        )

    # Step 5: nullifier == unique_identifier.
    if proof.nullifier != token.unique_identifier:
        raise VerifyZkPassportError(
            RejectionReason.ZKPASSPORT_NULLIFIER_MISMATCH,
            "proof.nullifier does not equal token.unique_identifier",
        )

    # Step 6: agent_key binding.
    expected_agent_commit = _agent_key_commitment(token.agent_key)
    if proof.agent_key_commitment.lower() != expected_agent_commit:
        raise VerifyZkPassportError(
            RejectionReason.ZKPASSPORT_AGENT_BINDING_MISMATCH,
            "agent_key_commitment does not match SHA256(token.agent_key)",
        )

    # Step 7: predicate binding (both the commitment AND the readable dict).
    expected_pred_commit = _predicate_commitment(token.disclosed_predicates)
    if proof.predicate_commitment.lower() != expected_pred_commit:
        raise VerifyZkPassportError(
            RejectionReason.ZKPASSPORT_PREDICATES_MISMATCH,
            "predicate_commitment does not match SHA256(canonical_json(predicates))",
        )
    if proof.disclosed != token.disclosed_predicates:
        raise VerifyZkPassportError(
            RejectionReason.ZKPASSPORT_PREDICATES_MISMATCH,
            "proof.disclosed differs from token.disclosed_predicates",
        )

    # Step 8: proof expiry.
    moment = now or datetime.now(timezone.utc)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    proof_exp = proof.expires_at
    if proof_exp.tzinfo is None:
        proof_exp = proof_exp.replace(tzinfo=timezone.utc)
    tok_exp = token.expires_at
    if tok_exp.tzinfo is None:
        tok_exp = tok_exp.replace(tzinfo=timezone.utc)
    if proof_exp <= moment:
        raise VerifyZkPassportError(
            RejectionReason.ZKPASSPORT_PROOF_EXPIRED,
            f"proof.expires_at={proof_exp.isoformat()} now={moment.isoformat()}",
        )
    if proof_exp < tok_exp:
        # A delegation token must never outlive its proof.
        raise VerifyZkPassportError(
            RejectionReason.ZKPASSPORT_PROOF_EXPIRED,
            "proof expires before delegation token",
        )

    return VerifiedZkPassport(proof=proof)


# ---------------------------------------------------------------------------
# Proof minting (helpers used by mock-phone + tests).
#
# Real production code does not mint proofs — only a real passport+phone+SNARK
# does. These helpers are exposed so the dev mock-phone, conftest fixtures,
# and integration tests can construct proofs that pass verification.


def mint_zkpassport_proof(
    *,
    issuer_signing_key,  # nacl.signing.SigningKey
    issuer_key_id: str,
    nullifier_b64: str,
    agent_key_b64: str,
    disclosed_predicates: dict[str, str],
    issued_at: datetime,
    expires_at: datetime,
    scope: str = "hearme.network|v1",
    scheme: str = "zkpassport.v1.test",
) -> dict:
    """Build + sign a valid ZkPassportProof dict.

    Returned dict round-trips through :class:`ZkPassportProof` and verifies
    cleanly against the issuer pubkey corresponding to ``issuer_signing_key``.
    """
    agent_raw = base64.b64decode(agent_key_b64, validate=True)
    agent_commit = hashlib.sha256(agent_raw).hexdigest()
    pred_commit = hashlib.sha256(canonical_json(disclosed_predicates)).hexdigest()

    def _iso(dt: datetime) -> str:
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")

    body = {
        "version": 1,
        "scheme": scheme,
        "issuer_key_id": issuer_key_id,
        "scope": scope,
        "nullifier": nullifier_b64,
        "agent_key_commitment": agent_commit,
        "predicate_commitment": pred_commit,
        "disclosed": disclosed_predicates,
        "issued_at": _iso(issued_at),
        "expires_at": _iso(expires_at),
    }
    sig = issuer_signing_key.sign(canonical_json(body)).signature
    body["issuer_signature"] = base64.b64encode(sig).decode("ascii")
    return body


def pack_proof(proof_dict: dict) -> str:
    """Encode a proof dict into the on-wire ``zkpassport_proof`` string."""
    return base64.b64encode(canonical_json(proof_dict)).decode("ascii")
