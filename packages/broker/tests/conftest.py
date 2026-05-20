"""Shared test fixtures.

The zkPassport SNARK verification is delegated to the Node bridge in
production; in tests we replace that one network call with a deterministic
fake (``mock_bridge``, autouse) and steer its outputs via test-only fields
embedded in the bundle (``query._test_outputs``). Everything else — the
binding checks, the agent signature, the DB constraints — runs for real.

The Postgres-dependent suite (test_uniqueness, test_aggregate_recompute)
spins up a real Postgres via ``testcontainers``; skipped if Docker is absent.
"""

from __future__ import annotations

import base64
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

import asyncpg
import pytest
import pytest_asyncio
from nacl.signing import SigningKey

from hearme_broker.verify.bridge_client import BridgeVerifyResult
from hearme_broker.verify.canonical import canonical_json


# ----- crypto helpers ----------------------------------------------------


@pytest.fixture(scope="session")
def agent_signing_key() -> SigningKey:
    return SigningKey(b"AGENT-KEY-FOR-HEARME-TESTING-32B")


# ----- mocked zkpassport-bridge -----------------------------------------


@pytest.fixture(autouse=True)
def mock_bridge(monkeypatch):
    """Replace the bridge ``verify_bundle`` call with a deterministic fake.

    The fake echoes test-controlled outputs embedded in the bundle's
    ``query._test_outputs`` so each test can steer verified / uniqueIdentifier
    / disclosed without a real Node bridge or any network.
    """

    async def _fake_verify_bundle(
        *, bridge_url, proofs, query, query_result, timeout=30.0
    ):
        outputs = (query or {}).get("_test_outputs") or {}
        bound = ((query or {}).get("bind") or {}).get("custom_data")
        return BridgeVerifyResult(
            verified=outputs.get("verified", True),
            unique_identifier=outputs.get("uniqueIdentifier"),
            disclosed=outputs.get("disclosed") or {},
            bound_agent_key=bound,
        )

    monkeypatch.setattr(
        "hearme_broker.verify.zkpassport.verify_bundle", _fake_verify_bundle
    )
    return _fake_verify_bundle


# ----- bundle + token + envelope factories ------------------------------


def _make_bundle(
    *,
    agent_key_b64: str,
    unique_identifier: str,
    disclosed: dict[str, str],
    scope: str = "v1",
    bound_agent_key: str | None = None,
    verified: bool = True,
    verified_uid: str | None = None,
    verified_disclosed: dict[str, str] | None = None,
) -> dict[str, Any]:
    """A verifiable-shaped zkPassport bundle with test-only verify outputs."""
    return {
        "version": 1,
        "proofs": [{"name": "test_circuit", "proof": "00", "version": "1"}],
        "query": {
            "bind": {
                "custom_data": bound_agent_key
                if bound_agent_key is not None
                else agent_key_b64
            },
            "_test_outputs": {
                "verified": verified,
                "uniqueIdentifier": verified_uid
                if verified_uid is not None
                else unique_identifier,
                "disclosed": verified_disclosed
                if verified_disclosed is not None
                else disclosed,
            },
        },
        "queryResult": {
            "age": {"gte": {"result": True}},
            "nationality": {"in": {"result": True}},
        },
        "scope": scope,
    }


@pytest.fixture
def make_bundle() -> Callable[..., dict[str, Any]]:
    return _make_bundle


@pytest.fixture
def make_token(
    agent_signing_key: SigningKey,
) -> Callable[..., dict[str, Any]]:
    """Build a DelegationToken dict wrapping a (mock-verifiable) zkPassport bundle."""

    def _factory(
        *,
        unique_identifier: str | None = None,
        disclosed_predicates: dict[str, str] | None = None,
        issued_at: datetime | None = None,
        expires_at: datetime | None = None,
        agent_pubkey: bytes | None = None,
        scope: str = "v1",
        bound_agent_key: str | None = None,
        verified: bool = True,
        verified_unique_identifier: str | None = None,
        verified_disclosed: dict[str, str] | None = None,
        bundle: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        now = datetime.now(timezone.utc)
        token_expires = (expires_at or now + timedelta(days=89)).astimezone(
            timezone.utc
        )
        uid = unique_identifier or "zkp:" + base64.b64encode(b"\x01" * 32).decode(
            "ascii"
        )
        predicates = (
            disclosed_predicates
            if disclosed_predicates is not None
            else {"region": "EU", "age_band": "18+"}
        )
        agent_b64 = base64.b64encode(
            agent_pubkey or agent_signing_key.verify_key.encode()
        ).decode("ascii")

        the_bundle = bundle or _make_bundle(
            agent_key_b64=agent_b64,
            unique_identifier=uid,
            disclosed=predicates,
            scope=scope,
            bound_agent_key=bound_agent_key,
            verified=verified,
            verified_uid=verified_unique_identifier,
            verified_disclosed=verified_disclosed,
        )
        proof_b64 = base64.b64encode(canonical_json(the_bundle)).decode("ascii")

        return {
            "version": 1,
            "zkpassport_proof": proof_b64,
            "domain": "hearme.network",
            "scope": "v1",
            "unique_identifier": uid,
            "disclosed_predicates": predicates,
            "agent_key": agent_b64,
            "issued_at": (issued_at or now - timedelta(days=1))
            .astimezone(timezone.utc)
            .isoformat()
            .replace("+00:00", "Z"),
            "expires_at": token_expires.isoformat().replace("+00:00", "Z"),
        }

    return _factory


@pytest.fixture
def make_envelope(agent_signing_key: SigningKey):
    """Build a valid signed envelope dict given a token + question fields."""
    from hearme_broker.verify.canonical import delegation_hash
    from hearme_broker.verify.envelope import envelope_signing_input

    def _factory(
        token: dict[str, Any],
        *,
        question_id: uuid.UUID,
        answer: str,
        nonce: str,
    ) -> dict[str, Any]:
        dhash = delegation_hash(token)
        digest = envelope_signing_input(question_id, answer, nonce, dhash)
        sig = agent_signing_key.sign(digest).signature
        return {
            "question_id": str(question_id),
            "answer": answer,
            "nonce": nonce,
            "delegation_token": token,
            "agent_signature": base64.b64encode(sig).decode("ascii"),
        }

    return _factory


# ----- Postgres testcontainer -------------------------------------------


def _read_schema() -> str:
    # tests/conftest.py → packages/broker/tests → 3 up == repo root.
    repo_root = Path(__file__).resolve().parents[3]
    schema = repo_root / "packages" / "web" / "drizzle" / "0000_init.sql"
    return schema.read_text()


@pytest_asyncio.fixture
async def pg_pool():
    """Spin up an ephemeral Postgres, apply the web schema, yield an asyncpg pool.

    Skipped if Docker / testcontainers isn't usable on the host.
    """
    try:
        from testcontainers.postgres import PostgresContainer  # type: ignore
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"testcontainers not available: {exc}")

    try:
        container = PostgresContainer("postgres:16")
        container.start()
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"could not start postgres container (is docker running?): {exc}")

    try:
        dsn = container.get_connection_url().replace(
            "postgresql+psycopg2://", "postgres://"
        )
        pool = await asyncpg.create_pool(dsn=dsn, min_size=1, max_size=4)
        async with pool.acquire() as conn:
            await conn.execute(_read_schema())
        yield pool
        await pool.close()
    finally:
        container.stop()
