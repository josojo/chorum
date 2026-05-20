"""ZK passport proof verification — happy path + every binding swap rejects.

The four bindings the broker enforces (scope, nullifier, agent_key,
predicates) are each tested by mutating the proof after issuance; the
issuer signature breaks, OR — when we re-sign — the broker catches the
mismatch against the corresponding DelegationToken field. Either failure
mode is acceptable; we assert on the specific rejection reason the
broker exposes.
"""

from __future__ import annotations

import base64
import json
from datetime import datetime, timedelta, timezone

import pytest
from nacl.signing import SigningKey

from hearme_broker.models.schemas import DelegationToken, RejectionReason
from hearme_broker.verify.canonical import canonical_json
from hearme_broker.verify.delegation import (
    VerifyDelegationError,
    verify_delegation,
)
from hearme_broker.verify.zkpassport import (
    VerifyZkPassportError,
    pack_proof,
    verify_zkpassport_proof,
)


def _pack_with_new_signature(proof: dict, signing_key: SigningKey) -> dict:
    """Re-sign a (possibly-mutated) proof under the given key."""
    out = {k: v for k, v in proof.items() if k != "issuer_signature"}
    sig = signing_key.sign(canonical_json(out)).signature
    out["issuer_signature"] = base64.b64encode(sig).decode("ascii")
    return out


def test_happy_path(make_token):
    raw = make_token()
    token = DelegationToken.model_validate(raw)
    out = verify_delegation(token)
    assert out.zk_proof.scope == "hearme.network|v1"
    assert out.zk_proof.nullifier == token.unique_identifier


def test_malformed_base64_rejected(make_token):
    raw = make_token()
    raw["zkpassport_proof"] = "!!!not-base64!!!"
    token = DelegationToken.model_validate(raw)
    with pytest.raises(VerifyDelegationError) as exc:
        verify_delegation(token)
    # Tampering after the phone signed breaks the phone signature first.
    assert exc.value.reason in (
        RejectionReason.PHONE_SIGNATURE_INVALID,
        RejectionReason.ZKPASSPORT_PROOF_MALFORMED,
    )


def test_malformed_proof_payload_rejected_when_phone_resigns(
    make_token, phone_signing_key
):
    """If a malicious phone replaces the proof and re-signs the bundle,
    the broker still rejects via the ZK proof parse step."""
    raw = make_token()
    # Replace the proof with garbage and re-sign the outer token.
    raw["zkpassport_proof"] = base64.b64encode(b"not-json").decode("ascii")
    payload = {k: v for k, v in raw.items() if k != "phone_signature"}
    sig = phone_signing_key.sign(canonical_json(payload)).signature
    raw["phone_signature"] = base64.b64encode(sig).decode("ascii")

    token = DelegationToken.model_validate(raw)
    with pytest.raises(VerifyDelegationError) as exc:
        verify_delegation(token)
    assert exc.value.reason is RejectionReason.ZKPASSPORT_PROOF_MALFORMED


def test_unknown_issuer_rejected(make_token, make_zk_proof, phone_signing_key):
    """A proof minted under an unregistered issuer_key_id is rejected."""
    raw = make_token()
    token = DelegationToken.model_validate(raw)
    bad_proof = make_zk_proof(
        agent_key_b64=token.agent_key,
        nullifier_b64=token.unique_identifier,
        disclosed=token.disclosed_predicates,
        issuer_key_id="not-in-registry",
        expires_at=token.expires_at + timedelta(minutes=1),
    )
    raw["zkpassport_proof"] = pack_proof(bad_proof)
    # Re-sign the outer bundle so the phone-signature step passes.
    payload = {k: v for k, v in raw.items() if k != "phone_signature"}
    sig = phone_signing_key.sign(canonical_json(payload)).signature
    raw["phone_signature"] = base64.b64encode(sig).decode("ascii")
    token = DelegationToken.model_validate(raw)
    with pytest.raises(VerifyDelegationError) as exc:
        verify_delegation(token)
    assert exc.value.reason is RejectionReason.ZKPASSPORT_ISSUER_UNKNOWN


def test_bad_issuer_signature_rejected(make_token, phone_signing_key):
    """Flip a byte in the issuer signature → ZKPASSPORT_SIGNATURE_INVALID."""
    raw = make_token()
    proof = json.loads(base64.b64decode(raw["zkpassport_proof"]).decode("utf-8"))
    sig = bytearray(base64.b64decode(proof["issuer_signature"]))
    sig[0] ^= 0xFF
    proof["issuer_signature"] = base64.b64encode(bytes(sig)).decode("ascii")
    raw["zkpassport_proof"] = pack_proof(proof)
    # Re-sign the outer bundle.
    payload = {k: v for k, v in raw.items() if k != "phone_signature"}
    sig2 = phone_signing_key.sign(canonical_json(payload)).signature
    raw["phone_signature"] = base64.b64encode(sig2).decode("ascii")
    token = DelegationToken.model_validate(raw)
    with pytest.raises(VerifyDelegationError) as exc:
        verify_delegation(token)
    assert exc.value.reason is RejectionReason.ZKPASSPORT_SIGNATURE_INVALID


def test_scope_mismatch_rejected(make_token, make_zk_proof, phone_signing_key):
    raw = make_token()
    token = DelegationToken.model_validate(raw)
    bad_proof = make_zk_proof(
        agent_key_b64=token.agent_key,
        nullifier_b64=token.unique_identifier,
        disclosed=token.disclosed_predicates,
        scope="evil.example|v1",
        expires_at=token.expires_at + timedelta(minutes=1),
    )
    raw["zkpassport_proof"] = pack_proof(bad_proof)
    payload = {k: v for k, v in raw.items() if k != "phone_signature"}
    sig = phone_signing_key.sign(canonical_json(payload)).signature
    raw["phone_signature"] = base64.b64encode(sig).decode("ascii")
    token = DelegationToken.model_validate(raw)
    with pytest.raises(VerifyDelegationError) as exc:
        verify_delegation(token)
    assert exc.value.reason is RejectionReason.ZKPASSPORT_SCOPE_MISMATCH


def test_nullifier_mismatch_rejected(make_token, make_zk_proof, phone_signing_key):
    """Proof binds to a different nullifier than the token's unique_identifier."""
    raw = make_token()
    token = DelegationToken.model_validate(raw)
    other_nullifier = base64.b64encode(b"\x99" * 32).decode("ascii")
    bad_proof = make_zk_proof(
        agent_key_b64=token.agent_key,
        nullifier_b64=other_nullifier,
        disclosed=token.disclosed_predicates,
        expires_at=token.expires_at + timedelta(minutes=1),
    )
    raw["zkpassport_proof"] = pack_proof(bad_proof)
    payload = {k: v for k, v in raw.items() if k != "phone_signature"}
    sig = phone_signing_key.sign(canonical_json(payload)).signature
    raw["phone_signature"] = base64.b64encode(sig).decode("ascii")
    token = DelegationToken.model_validate(raw)
    with pytest.raises(VerifyDelegationError) as exc:
        verify_delegation(token)
    assert exc.value.reason is RejectionReason.ZKPASSPORT_NULLIFIER_MISMATCH


def test_agent_binding_mismatch_rejected(
    make_token, make_zk_proof, phone_signing_key
):
    """Captured proof + new agent_key fails the agent-key commitment check."""
    raw = make_token()
    token = DelegationToken.model_validate(raw)
    # Mint a proof for a completely different agent.
    other_agent_b64 = base64.b64encode(b"\x42" * 32).decode("ascii")
    bad_proof = make_zk_proof(
        agent_key_b64=other_agent_b64,
        nullifier_b64=token.unique_identifier,
        disclosed=token.disclosed_predicates,
        expires_at=token.expires_at + timedelta(minutes=1),
    )
    raw["zkpassport_proof"] = pack_proof(bad_proof)
    payload = {k: v for k, v in raw.items() if k != "phone_signature"}
    sig = phone_signing_key.sign(canonical_json(payload)).signature
    raw["phone_signature"] = base64.b64encode(sig).decode("ascii")
    token = DelegationToken.model_validate(raw)
    with pytest.raises(VerifyDelegationError) as exc:
        verify_delegation(token)
    assert exc.value.reason is RejectionReason.ZKPASSPORT_AGENT_BINDING_MISMATCH


def test_predicates_mismatch_rejected(
    make_token, make_zk_proof, phone_signing_key
):
    """Phone tampered with disclosed_predicates after the issuer signed the proof."""
    raw = make_token()
    token = DelegationToken.model_validate(raw)
    # Proof committed to the ORIGINAL predicates.
    proof_dict = json.loads(
        base64.b64decode(raw["zkpassport_proof"]).decode("utf-8")
    )
    # Phone bumps predicates in the outer token to something more flattering.
    raw["disclosed_predicates"] = {"region": "EU", "age_band": "18-24"}
    # Re-sign the outer token (proof's predicate_commitment is now stale).
    payload = {k: v for k, v in raw.items() if k != "phone_signature"}
    sig = phone_signing_key.sign(canonical_json(payload)).signature
    raw["phone_signature"] = base64.b64encode(sig).decode("ascii")
    token = DelegationToken.model_validate(raw)
    with pytest.raises(VerifyDelegationError) as exc:
        verify_delegation(token)
    assert exc.value.reason is RejectionReason.ZKPASSPORT_PREDICATES_MISMATCH
    # Sanity: the proof structure parsed; this was a binding mismatch, not garbage.
    assert proof_dict["scheme"] == "zkpassport.v1.test"


def test_expired_proof_rejected(make_token, make_zk_proof, phone_signing_key):
    """Proof past its own expires_at is rejected even if the outer token is fresh."""
    raw = make_token()
    token = DelegationToken.model_validate(raw)
    now = datetime.now(timezone.utc)
    expired_proof = make_zk_proof(
        agent_key_b64=token.agent_key,
        nullifier_b64=token.unique_identifier,
        disclosed=token.disclosed_predicates,
        issued_at=now - timedelta(days=10),
        expires_at=now - timedelta(seconds=1),
    )
    raw["zkpassport_proof"] = pack_proof(expired_proof)
    payload = {k: v for k, v in raw.items() if k != "phone_signature"}
    sig = phone_signing_key.sign(canonical_json(payload)).signature
    raw["phone_signature"] = base64.b64encode(sig).decode("ascii")
    token = DelegationToken.model_validate(raw)
    with pytest.raises(VerifyDelegationError) as exc:
        verify_delegation(token)
    assert exc.value.reason is RejectionReason.ZKPASSPORT_PROOF_EXPIRED


def test_proof_expires_before_token_rejected(
    make_token, make_zk_proof, phone_signing_key
):
    """Token outlives the proof → rejected with PROOF_EXPIRED."""
    raw = make_token()
    token = DelegationToken.model_validate(raw)
    now = datetime.now(timezone.utc)
    # Token expires in 89 days; proof in 1 day.
    short_proof = make_zk_proof(
        agent_key_b64=token.agent_key,
        nullifier_b64=token.unique_identifier,
        disclosed=token.disclosed_predicates,
        expires_at=now + timedelta(days=1),
    )
    raw["zkpassport_proof"] = pack_proof(short_proof)
    payload = {k: v for k, v in raw.items() if k != "phone_signature"}
    sig = phone_signing_key.sign(canonical_json(payload)).signature
    raw["phone_signature"] = base64.b64encode(sig).decode("ascii")
    token = DelegationToken.model_validate(raw)
    with pytest.raises(VerifyDelegationError) as exc:
        verify_delegation(token)
    assert exc.value.reason is RejectionReason.ZKPASSPORT_PROOF_EXPIRED


def test_direct_verifier_returns_parsed_proof(make_token):
    """Sanity: the dedicated verifier gives callers the parsed proof back."""
    raw = make_token()
    token = DelegationToken.model_validate(raw)
    out = verify_zkpassport_proof(token)
    assert out.proof.scope == "hearme.network|v1"
    assert out.proof.nullifier == token.unique_identifier
