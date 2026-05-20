"""Delegation verification — happy path, expiry, and ZK failures surface.

There is no phone signature anymore: integrity comes from the zkPassport SNARK
(verified via the bridge — mocked here, see conftest). Revocation is a DB
lookup tested in test_uniqueness.py against real Postgres.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from hearme_broker.models.schemas import DelegationToken, RejectionReason
from hearme_broker.verify.delegation import (
    VerifyDelegationError,
    verify_delegation,
)


async def test_happy_path(make_token):
    token = DelegationToken.model_validate(make_token())
    out = await verify_delegation(token)
    assert len(out.delegation_hash) == 64
    assert out.unique_identifier == token.unique_identifier
    assert out.disclosed == token.disclosed_predicates


async def test_expired_token_rejected(make_token):
    past = datetime.now(timezone.utc) - timedelta(seconds=1)
    raw = make_token(
        issued_at=datetime.now(timezone.utc) - timedelta(days=100),
        expires_at=past,
    )
    token = DelegationToken.model_validate(raw)
    with pytest.raises(VerifyDelegationError) as exc:
        await verify_delegation(token)
    assert exc.value.reason is RejectionReason.TOKEN_EXPIRED


async def test_zk_failure_surfaces_through_delegation(make_token):
    """A ZK rejection reason flows out as a VerifyDelegationError."""
    token = DelegationToken.model_validate(make_token(verified=False))
    with pytest.raises(VerifyDelegationError) as exc:
        await verify_delegation(token)
    assert exc.value.reason is RejectionReason.ZKPASSPORT_PROOF_INVALID


async def test_malformed_proof_surfaces_through_delegation(make_token):
    raw = make_token()
    raw["zkpassport_proof"] = "!!!not-base64!!!"
    token = DelegationToken.model_validate(raw)
    with pytest.raises(VerifyDelegationError) as exc:
        await verify_delegation(token)
    assert exc.value.reason is RejectionReason.ZKPASSPORT_PROOF_MALFORMED
