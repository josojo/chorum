"""Skill-side ingest of a broker-issued DelegationToken.

Verify-once: the token is broker-signed and opaque to the skill. The skill only
runs cheap structural checks (``self_identity.validate_token``) so obvious
mistakes are caught before an envelope is built; the broker does the real
validation at answer time.
"""

from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest

from hearme_skill.delegation import load_delegation
from hearme_skill.models import DelegationToken
from hearme_skill.onboarding import IdentityBundleError, accept_identity_bundle
from hearme_skill.self_identity import validate_token


def _serialize(token: DelegationToken) -> str:
    return json.dumps(token.model_dump(mode="json"), sort_keys=True)


def test_happy_path_accepts_and_stores(tmp_root: Path, fresh_token):
    out = tmp_root / "delegation.token"
    accepted = accept_identity_bundle(raw_json=_serialize(fresh_token), delegation_path=out)
    assert accepted.unique_identifier == fresh_token.unique_identifier
    on_disk = load_delegation(out)
    assert on_disk.model_dump(mode="json") == fresh_token.model_dump(mode="json")


def test_validate_token_accepts_matching_agent_key(fresh_token):
    validate_token(fresh_token, expected_agent_key=fresh_token.agent_key)


def test_validate_token_rejects_wrong_agent_key(fresh_token):
    other = base64.b64encode(b"\x42" * 32).decode("ascii")
    with pytest.raises(IdentityBundleError, match="agent"):
        validate_token(fresh_token, expected_agent_key=other)


def test_missing_broker_signature_rejected(fresh_token):
    tampered = fresh_token.model_copy(update={"broker_signature": ""})
    with pytest.raises(IdentityBundleError, match="broker_signature"):
        validate_token(tampered)


def test_malformed_json_rejected(tmp_root: Path):
    with pytest.raises(Exception):
        accept_identity_bundle(
            raw_json="{not valid json", delegation_path=tmp_root / "delegation.token"
        )
