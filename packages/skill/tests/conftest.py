"""Shared test fixtures.

Per ARCHITECTURE.md §12 no test in this suite makes a live LLM or HTTP call.
All external collaborators are doubles defined here or in the package's
`memory/` and `llm/` modules.

DelegationTokens now wrap a real zkPassport bundle (no phone signature). The
fixtures build a bundle of the right shape — bound to the agent key — so the
skill's cheap structural checks (`zk_passport.verify_bindings`) pass. Full
SNARK verification is the broker's job and is not exercised here.
"""

from __future__ import annotations

import base64
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any
from pathlib import Path

import pytest

from hearme_skill.crypto.canonical import canonical_json_bytes
from hearme_skill.crypto.ed25519 import Keypair, generate_keypair
from hearme_skill.models import DelegationToken, Question


def _make_bundle(*, agent_key_b64: str, scope: str = "v1") -> dict[str, Any]:
    """A verifiable-shaped zkPassport bundle bound to ``agent_key_b64``."""
    return {
        "version": 1,
        "proofs": [{"name": "test_circuit", "proof": "00", "version": "1"}],
        "query": {"bind": {"custom_data": agent_key_b64}},
        "queryResult": {
            "age": {"gte": {"result": True}},
            "nationality": {"in": {"result": True}},
        },
        "scope": scope,
    }


def _build_token(
    *,
    agent_keypair: Keypair,
    unique_id: str,
    disclosed: dict[str, str],
    issued_at: datetime,
    expires_at: datetime,
) -> DelegationToken:
    agent_b64 = base64.b64encode(agent_keypair.public_bytes).decode("ascii")
    bundle = _make_bundle(agent_key_b64=agent_b64)
    proof_b64 = base64.b64encode(canonical_json_bytes(bundle)).decode("ascii")
    return DelegationToken.model_validate(
        {
            "version": 1,
            "zkpassport_proof": proof_b64,
            "domain": "hearme.network",
            "scope": "v1",
            "unique_identifier": unique_id,
            "disclosed_predicates": disclosed,
            "agent_key": agent_b64,
            "issued_at": issued_at.isoformat().replace("+00:00", "Z"),
            "expires_at": expires_at.isoformat().replace("+00:00", "Z"),
        }
    )


@pytest.fixture
def agent_keypair() -> Keypair:
    return generate_keypair()


@pytest.fixture
def now() -> datetime:
    return datetime(2026, 5, 19, 12, 0, 0, tzinfo=timezone.utc)


@pytest.fixture
def fresh_token(agent_keypair: Keypair, now: datetime) -> DelegationToken:
    """A freshly-issued DelegationToken wrapping a (bundle-shaped) zkPassport proof."""
    return _build_token(
        agent_keypair=agent_keypair,
        unique_id=base64.b64encode(b"u" * 32).decode("ascii"),
        disclosed={"age_band": "18+", "region": "EU"},
        issued_at=now,
        expires_at=now + timedelta(days=90),
    )


@pytest.fixture
def expired_token(agent_keypair: Keypair, now: datetime) -> DelegationToken:
    past = now - timedelta(days=100)
    return _build_token(
        agent_keypair=agent_keypair,
        unique_id=base64.b64encode(b"u" * 32).decode("ascii"),
        disclosed={"age_band": "18+", "region": "EU"},
        issued_at=past - timedelta(days=90),
        expires_at=past,
    )


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
