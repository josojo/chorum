"""Skill-side identity-bundle ingest.

Covers ``onboarding.accept_identity_bundle`` and the binding checks in
``zk_passport.verify_bindings``. These checks are intentionally a strict
subset of the broker's pipeline — the skill catches obvious mismatches
locally so the user finds out before submitting a doomed envelope; the
broker is the source of truth for issuer-signature verification.
"""

from __future__ import annotations

import base64
import json
from datetime import timedelta
from pathlib import Path

import pytest

from hearme_skill.crypto.canonical import canonical_json_bytes
from hearme_skill.crypto.ed25519 import Keypair, sign
from hearme_skill.delegation import load_delegation
from hearme_skill.models import DelegationToken
from hearme_skill.onboarding import (
    IdentityBundleError,
    accept_identity_bundle,
)
from hearme_skill.zk_passport import (
    ZkPassportProof,
    parse_proof_from_token,
    verify_bindings,
)


def _serialize(token: DelegationToken) -> str:
    return json.dumps(token.model_dump(mode="json"), sort_keys=True)


def _resign_token(
    token: DelegationToken, phone_keypair: Keypair
) -> DelegationToken:
    d = token.model_dump(mode="json")
    d.pop("phone_signature", None)
    sig = sign(phone_keypair, canonical_json_bytes(d))
    d["phone_signature"] = base64.b64encode(sig).decode("ascii")
    return DelegationToken.model_validate(d)


def test_happy_path_accepts_and_stores(tmp_root: Path, fresh_token):
    out = tmp_root / "delegation.token"
    raw_json = _serialize(fresh_token)
    accepted = accept_identity_bundle(raw_json=raw_json, delegation_path=out)
    assert accepted.unique_identifier == fresh_token.unique_identifier
    on_disk = load_delegation(out)
    assert on_disk.model_dump(mode="json") == fresh_token.model_dump(mode="json")


def test_parse_proof_round_trip(fresh_token):
    proof = parse_proof_from_token(fresh_token)
    assert isinstance(proof, ZkPassportProof)
    assert proof.scope == "hearme.network|v1"
    assert proof.nullifier == fresh_token.unique_identifier


def test_verify_bindings_accepts_valid_token(fresh_token):
    proof = verify_bindings(fresh_token)
    assert proof.disclosed == fresh_token.disclosed_predicates


def test_malformed_proof_blob_rejected(tmp_root: Path, fresh_token, phone_keypair):
    tampered = fresh_token.model_copy(update={"zkpassport_proof": "!!not-base64!!"})
    tampered = _resign_token(tampered, phone_keypair)
    with pytest.raises(IdentityBundleError):
        accept_identity_bundle(
            raw_json=_serialize(tampered),
            delegation_path=tmp_root / "delegation.token",
        )


def test_scope_mismatch_rejected_locally(fresh_token, phone_keypair, issuer_keypair):
    """Skill catches scope mismatch even without checking the issuer sig."""
    proof_dict = json.loads(
        base64.b64decode(fresh_token.zkpassport_proof).decode("utf-8")
    )
    proof_dict["scope"] = "evil.example|v1"
    # Re-sign the (tampered) proof under the test issuer key so it parses.
    proof_dict.pop("issuer_signature", None)
    sig = sign(issuer_keypair, canonical_json_bytes(proof_dict))
    proof_dict["issuer_signature"] = base64.b64encode(sig).decode("ascii")
    new_proof_b64 = base64.b64encode(canonical_json_bytes(proof_dict)).decode("ascii")
    tampered = fresh_token.model_copy(update={"zkpassport_proof": new_proof_b64})
    tampered = _resign_token(tampered, phone_keypair)
    with pytest.raises(IdentityBundleError, match="scope"):
        verify_bindings(tampered)


def test_predicate_drift_rejected_locally(
    fresh_token, phone_keypair
):
    """Phone tampers with disclosed_predicates after the proof was minted."""
    tampered = fresh_token.model_copy(
        update={"disclosed_predicates": {"age_band": "18-24", "region": "EU"}}
    )
    tampered = _resign_token(tampered, phone_keypair)
    with pytest.raises(IdentityBundleError, match="predicate"):
        verify_bindings(tampered)


def test_agent_key_swap_rejected_locally(fresh_token, phone_keypair):
    """Captured proof + new agent_key fails the local commitment check."""
    new_agent = base64.b64encode(b"\x42" * 32).decode("ascii")
    tampered = fresh_token.model_copy(update={"agent_key": new_agent})
    tampered = _resign_token(tampered, phone_keypair)
    with pytest.raises(IdentityBundleError, match="agent_key_commitment"):
        verify_bindings(tampered)
