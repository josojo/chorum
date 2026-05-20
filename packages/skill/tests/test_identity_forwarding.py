"""Skill-side identity-bundle ingest.

Covers ``onboarding.accept_identity_bundle`` and the structural checks in
``zk_passport.verify_bindings``. These are a strict subset of the broker's
pipeline — the skill catches obvious mismatches locally so the user finds out
before submitting a doomed envelope; the broker runs the real SNARK check.
"""

from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest

from hearme_skill.crypto.canonical import canonical_json_bytes
from hearme_skill.delegation import load_delegation
from hearme_skill.models import DelegationToken
from hearme_skill.onboarding import (
    IdentityBundleError,
    accept_identity_bundle,
)
from hearme_skill.zk_passport import (
    parse_bundle_from_token,
    verify_bindings,
)


def _serialize(token: DelegationToken) -> str:
    return json.dumps(token.model_dump(mode="json"), sort_keys=True)


def _with_bundle(token: DelegationToken, bundle: dict) -> DelegationToken:
    proof_b64 = base64.b64encode(canonical_json_bytes(bundle)).decode("ascii")
    return token.model_copy(update={"zkpassport_proof": proof_b64})


def test_happy_path_accepts_and_stores(tmp_root: Path, fresh_token):
    out = tmp_root / "delegation.token"
    accepted = accept_identity_bundle(raw_json=_serialize(fresh_token), delegation_path=out)
    assert accepted.unique_identifier == fresh_token.unique_identifier
    on_disk = load_delegation(out)
    assert on_disk.model_dump(mode="json") == fresh_token.model_dump(mode="json")


def test_parse_bundle_round_trip(fresh_token):
    bundle = parse_bundle_from_token(fresh_token)
    assert bundle["scope"] == "v1"
    assert bundle["query"]["bind"]["custom_data"] == fresh_token.agent_key
    assert isinstance(bundle["proofs"], list)


def test_verify_bindings_accepts_valid_token(fresh_token):
    bundle = verify_bindings(fresh_token)
    assert bundle["query"]["bind"]["custom_data"] == fresh_token.agent_key


def test_malformed_proof_blob_rejected(tmp_root: Path, fresh_token):
    tampered = fresh_token.model_copy(update={"zkpassport_proof": "!!not-base64!!"})
    with pytest.raises(IdentityBundleError):
        accept_identity_bundle(
            raw_json=_serialize(tampered),
            delegation_path=tmp_root / "delegation.token",
        )


def test_scope_mismatch_rejected_locally(fresh_token):
    bundle = parse_bundle_from_token(fresh_token)
    bundle["scope"] = "evil"
    tampered = _with_bundle(fresh_token, bundle)
    with pytest.raises(IdentityBundleError, match="scope"):
        verify_bindings(tampered)


def test_agent_key_swap_rejected_locally(fresh_token):
    """Captured proof (bound to the original key) + a new agent_key fails."""
    new_agent = base64.b64encode(b"\x42" * 32).decode("ascii")
    tampered = fresh_token.model_copy(update={"agent_key": new_agent})
    with pytest.raises(IdentityBundleError, match="agent_key"):
        verify_bindings(tampered)
