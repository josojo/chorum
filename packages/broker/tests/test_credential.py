"""Broker-issued session credential — sign/verify round-trip + tamper rejection."""

from __future__ import annotations

import base64
from datetime import datetime, timedelta, timezone

from hearme_broker.config import Settings
from hearme_broker.verify.credential import (
    issue_delegation_token,
    verify_broker_signature,
)


def _now():
    return datetime.now(timezone.utc)


def test_round_trip():
    tok = issue_delegation_token(
        unique_identifier="self:abc",
        disclosed_predicates={"region": "EU", "age_band": "35-49"},
        agent_key=base64.b64encode(b"\x01" * 32).decode("ascii"),
        issued_at=_now(),
        expires_at=_now() + timedelta(days=90),
    )
    assert tok.version == 2
    assert tok.scope == "hearme-v1"
    assert verify_broker_signature(tok) is True


def test_tamper_each_claim_rejected():
    tok = issue_delegation_token(
        unique_identifier="self:abc",
        disclosed_predicates={"region": "EU", "age_band": "35-49"},
        agent_key=base64.b64encode(b"\x01" * 32).decode("ascii"),
        issued_at=_now(),
        expires_at=_now() + timedelta(days=90),
    )
    for field, value in [
        ("unique_identifier", "self:evil"),
        ("agent_key", base64.b64encode(b"\x02" * 32).decode("ascii")),
        ("disclosed_predicates", {"region": "NA", "age_band": "18+"}),
        ("expires_at", _now() + timedelta(days=3650)),
    ]:
        tampered = tok.model_copy(update={field: value})
        assert verify_broker_signature(tampered) is False, field


def test_signature_from_a_different_broker_key_rejected():
    tok = issue_delegation_token(
        unique_identifier="self:abc",
        disclosed_predicates={"region": "EU", "age_band": "35-49"},
        agent_key=base64.b64encode(b"\x01" * 32).decode("ascii"),
        issued_at=_now(),
        expires_at=_now() + timedelta(days=90),
    )
    # A token signed under one broker key must not verify under another.
    other = Settings(
        broker_signing_key=base64.b64encode(b"\x09" * 32).decode("ascii")
    )
    assert verify_broker_signature(tok, settings=other) is False
