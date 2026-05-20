"""zkPassport proof verification — happy path + every binding/verify failure.

The real Noir/UltraHonk check runs in the Node bridge; here it's the
deterministic ``mock_bridge`` fake (see conftest). We assert the broker's
binding logic and the rejection reason for each failure mode.
"""

from __future__ import annotations

import base64
import json

import pytest

from hearme_broker.models.schemas import DelegationToken, RejectionReason
from hearme_broker.verify.bridge_client import BridgeError
from hearme_broker.verify.zkpassport import (
    VerifyZkPassportError,
    verify_zkpassport_proof,
)


async def test_happy_path(make_token):
    token = DelegationToken.model_validate(make_token())
    out = await verify_zkpassport_proof(token)
    assert out.unique_identifier == token.unique_identifier
    assert out.disclosed == token.disclosed_predicates


async def test_malformed_base64_rejected(make_token):
    raw = make_token()
    raw["zkpassport_proof"] = "!!!not-base64!!!"
    token = DelegationToken.model_validate(raw)
    with pytest.raises(VerifyZkPassportError) as exc:
        await verify_zkpassport_proof(token)
    assert exc.value.reason is RejectionReason.ZKPASSPORT_PROOF_MALFORMED


async def test_bundle_missing_keys_rejected(make_token):
    raw = make_token()
    raw["zkpassport_proof"] = base64.b64encode(
        json.dumps({"version": 1}).encode("utf-8")
    ).decode("ascii")
    token = DelegationToken.model_validate(raw)
    with pytest.raises(VerifyZkPassportError) as exc:
        await verify_zkpassport_proof(token)
    assert exc.value.reason is RejectionReason.ZKPASSPORT_PROOF_MALFORMED


async def test_agent_binding_mismatch_rejected(make_token):
    """A proof bound to a different agent_key fails the binding check."""
    other = base64.b64encode(b"\x42" * 32).decode("ascii")
    token = DelegationToken.model_validate(make_token(bound_agent_key=other))
    with pytest.raises(VerifyZkPassportError) as exc:
        await verify_zkpassport_proof(token)
    assert exc.value.reason is RejectionReason.ZKPASSPORT_AGENT_BINDING_MISMATCH


async def test_scope_mismatch_rejected(make_token):
    token = DelegationToken.model_validate(make_token(scope="evil"))
    with pytest.raises(VerifyZkPassportError) as exc:
        await verify_zkpassport_proof(token)
    assert exc.value.reason is RejectionReason.ZKPASSPORT_SCOPE_MISMATCH


async def test_proof_not_verified_rejected(make_token):
    token = DelegationToken.model_validate(make_token(verified=False))
    with pytest.raises(VerifyZkPassportError) as exc:
        await verify_zkpassport_proof(token)
    assert exc.value.reason is RejectionReason.ZKPASSPORT_PROOF_INVALID


async def test_nullifier_mismatch_rejected(make_token):
    """The verified uniqueIdentifier differs from the token's claim."""
    token = DelegationToken.model_validate(
        make_token(verified_unique_identifier="zkp:someone-else")
    )
    with pytest.raises(VerifyZkPassportError) as exc:
        await verify_zkpassport_proof(token)
    assert exc.value.reason is RejectionReason.ZKPASSPORT_NULLIFIER_MISMATCH


async def test_predicates_mismatch_rejected(make_token):
    """The verified disclosure differs from the token's claimed predicates."""
    token = DelegationToken.model_validate(
        make_token(verified_disclosed={"region": "non-EU"})
    )
    with pytest.raises(VerifyZkPassportError) as exc:
        await verify_zkpassport_proof(token)
    assert exc.value.reason is RejectionReason.ZKPASSPORT_PREDICATES_MISMATCH


async def test_bridge_error_surfaced(make_token, monkeypatch):
    async def _boom(**_kwargs):
        raise BridgeError("connection refused")

    monkeypatch.setattr(
        "hearme_broker.verify.zkpassport.verify_bundle", _boom
    )
    token = DelegationToken.model_validate(make_token())
    with pytest.raises(VerifyZkPassportError) as exc:
        await verify_zkpassport_proof(token)
    assert exc.value.reason is RejectionReason.ZKPASSPORT_BRIDGE_ERROR
