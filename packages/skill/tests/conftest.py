"""Shared test fixtures.

Per ARCHITECTURE.md §12 no test in this suite makes a live LLM or HTTP call.
All external collaborators are doubles defined here or in the package's
`memory/` and `llm/` modules.
"""

from __future__ import annotations

import base64
import hashlib
import json
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest

from hearme_skill.crypto.canonical import canonical_json, canonical_json_bytes
from hearme_skill.crypto.ed25519 import Keypair, generate_keypair, sign
from hearme_skill.models import DelegationToken, Question


def _mint_zk_proof_for_test(
    *,
    issuer_keypair: Keypair,
    issuer_key_id: str,
    agent_pubkey: bytes,
    nullifier_b64: str,
    disclosed: dict[str, str],
    issued_at: datetime,
    expires_at: datetime,
    scope: str = "hearme.network|v1",
) -> str:
    """Build a valid ZkPassportProof + return its base64 wire form."""

    def _iso(dt: datetime) -> str:
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")

    body = {
        "version": 1,
        "scheme": "zkpassport.v1.test",
        "issuer_key_id": issuer_key_id,
        "scope": scope,
        "nullifier": nullifier_b64,
        "agent_key_commitment": hashlib.sha256(agent_pubkey).hexdigest(),
        "predicate_commitment": hashlib.sha256(
            canonical_json_bytes(disclosed)
        ).hexdigest(),
        "disclosed": disclosed,
        "issued_at": _iso(issued_at),
        "expires_at": _iso(expires_at),
    }
    sig = sign(issuer_keypair, canonical_json_bytes(body))
    body["issuer_signature"] = base64.b64encode(sig).decode("ascii")
    return base64.b64encode(canonical_json_bytes(body)).decode("ascii")


@pytest.fixture
def phone_keypair() -> Keypair:
    return generate_keypair()


@pytest.fixture
def issuer_keypair() -> Keypair:
    """Stand-in for the zkPassport issuer (CSCA). Used to sign embedded proofs."""
    return generate_keypair()


ZK_TEST_ISSUER_KEY_ID = "icao-csca-test-skill"


@pytest.fixture
def agent_keypair() -> Keypair:
    return generate_keypair()


@pytest.fixture
def now() -> datetime:
    return datetime(2026, 5, 19, 12, 0, 0, tzinfo=timezone.utc)


@pytest.fixture
def fresh_token(
    phone_keypair: Keypair,
    issuer_keypair: Keypair,
    agent_keypair: Keypair,
    now: datetime,
) -> DelegationToken:
    """A freshly-issued DelegationToken signed by the test phone key, with a
    valid (test-issuer-signed) ZkPassportProof inside ``zkpassport_proof``."""

    unique_id = base64.b64encode(b"u" * 32).decode("ascii")
    disclosed = {"age_band": "25-34", "region": "EU"}
    token_expires = now + timedelta(days=90)

    proof_b64 = _mint_zk_proof_for_test(
        issuer_keypair=issuer_keypair,
        issuer_key_id=ZK_TEST_ISSUER_KEY_ID,
        agent_pubkey=agent_keypair.public_bytes,
        nullifier_b64=unique_id,
        disclosed=disclosed,
        issued_at=now,
        expires_at=token_expires + timedelta(minutes=1),
    )

    unsigned = {
        "version": 1,
        "zkpassport_proof": proof_b64,
        "domain": "hearme.network",
        "scope": "v1",
        "unique_identifier": unique_id,
        "disclosed_predicates": disclosed,
        "agent_key": base64.b64encode(agent_keypair.public_bytes).decode("ascii"),
        "issued_at": now.isoformat().replace("+00:00", "Z"),
        "expires_at": token_expires.isoformat().replace("+00:00", "Z"),
    }
    sig = sign(phone_keypair, canonical_json_bytes(unsigned))
    unsigned["phone_signature"] = base64.b64encode(sig).decode("ascii")
    return DelegationToken.model_validate(unsigned)


@pytest.fixture
def expired_token(
    phone_keypair: Keypair,
    issuer_keypair: Keypair,
    agent_keypair: Keypair,
    now: datetime,
) -> DelegationToken:
    past = now - timedelta(days=100)
    unique_id = base64.b64encode(b"u" * 32).decode("ascii")
    disclosed = {"age_band": "25-34", "region": "EU"}

    proof_b64 = _mint_zk_proof_for_test(
        issuer_keypair=issuer_keypair,
        issuer_key_id=ZK_TEST_ISSUER_KEY_ID,
        agent_pubkey=agent_keypair.public_bytes,
        nullifier_b64=unique_id,
        disclosed=disclosed,
        issued_at=past - timedelta(days=90),
        expires_at=past + timedelta(minutes=1),
    )

    unsigned = {
        "version": 1,
        "zkpassport_proof": proof_b64,
        "domain": "hearme.network",
        "scope": "v1",
        "unique_identifier": unique_id,
        "disclosed_predicates": disclosed,
        "agent_key": base64.b64encode(agent_keypair.public_bytes).decode("ascii"),
        "issued_at": (past - timedelta(days=90)).isoformat().replace("+00:00", "Z"),
        "expires_at": past.isoformat().replace("+00:00", "Z"),
    }
    sig = sign(phone_keypair, canonical_json_bytes(unsigned))
    unsigned["phone_signature"] = base64.b64encode(sig).decode("ascii")
    return DelegationToken.model_validate(unsigned)


@pytest.fixture
def question() -> Question:
    return Question(
        question_id=str(uuid.uuid4()),
        text="Do you prefer single-origin or blends?",
        topic="coffee",
        created_at=datetime(2026, 5, 19, 12, 0, 0, tzinfo=timezone.utc),
        closes_at=datetime(2026, 5, 20, 12, 0, 0, tzinfo=timezone.utc),
        nonce=base64.b64encode(b"n" * 16).decode("ascii"),
    )


class CountingPhoneBridge:
    """Records every call. The 'phone' shouldn't be called in steady state."""

    def __init__(self) -> None:
        self.call_count = 0
        self.calls: list[tuple[str, tuple[Any, ...]]] = []

    def __getattr__(self, name: str) -> Any:
        def _record(*args: Any, **kwargs: Any) -> Any:
            self.call_count += 1
            self.calls.append((name, args))
            raise AssertionError(
                f"phone bridge was contacted in steady state: {name}({args!r})"
            )

        return _record


@pytest.fixture
def phone_bridge() -> CountingPhoneBridge:
    return CountingPhoneBridge()


@pytest.fixture
def tmp_root(tmp_path: Path) -> Path:
    """Isolated `~/.hermes/hearme` for each test."""

    root = tmp_path / "hermes" / "hearme"
    root.mkdir(parents=True, exist_ok=True)
    return root
