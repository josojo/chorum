"""Per-envelope DelegationToken verification — broker signature + expiry.

No bridge / no Self proof on this path (verify-once). The token is broker-issued
and broker-signed; integrity is the broker's own signature. Registry/revocation
are DB lookups tested in test_uniqueness.py against real Postgres.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from hearme_broker.models.schemas import DelegationToken, RejectionReason
from hearme_broker.verify.delegation import (
    VerifyDelegationError,
    verify_delegation,
)


def test_happy_path(make_token):
    token = DelegationToken.model_validate(make_token())
    out = verify_delegation(token)
    assert len(out.delegation_hash) == 64
    assert out.unique_identifier == token.unique_identifier
    assert out.disclosed == token.disclosed_predicates


def test_expired_token_rejected(make_token):
    past = datetime.now(timezone.utc) - timedelta(seconds=1)
    token = DelegationToken.model_validate(
        make_token(
            issued_at=datetime.now(timezone.utc) - timedelta(days=100),
            expires_at=past,
        )
    )
    with pytest.raises(VerifyDelegationError) as exc:
        verify_delegation(token)
    assert exc.value.reason is RejectionReason.TOKEN_EXPIRED


def test_tampered_token_fails_broker_signature(make_token):
    raw = make_token()
    # Mutate a signed claim without re-signing — the broker signature must fail.
    raw["disclosed_predicates"] = {"region": "NA", "age_band": "65+"}
    token = DelegationToken.model_validate(raw)
    with pytest.raises(VerifyDelegationError) as exc:
        verify_delegation(token)
    assert exc.value.reason is RejectionReason.BROKER_SIGNATURE_INVALID


def test_forged_signature_rejected(make_token):
    import base64

    raw = make_token()
    raw["broker_signature"] = base64.b64encode(b"\x00" * 64).decode("ascii")
    token = DelegationToken.model_validate(raw)
    with pytest.raises(VerifyDelegationError) as exc:
        verify_delegation(token)
    assert exc.value.reason is RejectionReason.BROKER_SIGNATURE_INVALID
