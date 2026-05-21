"""Shared test fixtures.

Per ARCHITECTURE.md §12 no test in this suite makes a live LLM or HTTP call.
All external collaborators are doubles defined here or in the package's
`memory/` and `llm/` modules.

DelegationTokens are now broker-ISSUED (verify-once). The skill treats them as
opaque; it never verifies the broker signature (only the broker can). So these
fixtures build a structurally-valid v2 token with a placeholder broker_signature
— enough for the skill's local checks, hashing, and envelope signing.
"""

from __future__ import annotations

import base64
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest

from hearme_skill.crypto.ed25519 import Keypair, generate_keypair
from hearme_skill.models import DelegationToken, Question


def _build_token(
    *,
    agent_keypair: Keypair,
    unique_id: str,
    disclosed: dict[str, str],
    issued_at: datetime,
    expires_at: datetime,
) -> DelegationToken:
    agent_b64 = base64.b64encode(agent_keypair.public_bytes).decode("ascii")
    return DelegationToken.model_validate(
        {
            "version": 2,
            "scope": "hearme-v1",
            "unique_identifier": unique_id,
            "disclosed_predicates": disclosed,
            "agent_key": agent_b64,
            "issued_at": issued_at.isoformat().replace("+00:00", "Z"),
            "expires_at": expires_at.isoformat().replace("+00:00", "Z"),
            "broker_signature": base64.b64encode(b"\x00" * 64).decode("ascii"),
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
    """A freshly-issued, broker-signed DelegationToken (placeholder signature)."""
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
