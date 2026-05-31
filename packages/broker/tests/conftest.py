"""Shared test fixtures.

Verify-once model (ARCHITECTURE.md §5/§8): the skill posts an EnrollmentBundle
(Self proofs + agent_key) to POST /v1/register; the broker verifies the proofs
ONCE (off-chain SNARK via the self-bridge + on-chain registry check) and issues
a broker-signed DelegationToken the agent replays per answer.

In tests we replace the one network call to the self-bridge (``verify_self_proof``)
with a deterministic fake (``mock_bridge``, autouse) steered by a ``_test`` blob
embedded in each proof. Everything else — bindings, predicate derivation, the
broker signature, the DB constraints — runs for real.

The Postgres-dependent suite (test_uniqueness, test_aggregate_recompute) spins up
a real Postgres via ``testcontainers``; skipped if Docker is absent.
"""

from __future__ import annotations

import base64
import os
import uuid
from datetime import datetime, timedelta, timezone

# The broker fails closed by default: create_app() refuses to boot with the dev
# signing key / dev DB password unless HEARME_BROKER_DEV_MODE=1 is set. The test
# suite runs against those dev defaults, so opt into dev mode for the session.
# Tests that exercise the startup checks themselves override/delete this var.
os.environ.setdefault("HEARME_BROKER_DEV_MODE", "1")
from pathlib import Path
from typing import Any, Callable

import asyncpg
import pytest
import pytest_asyncio
from nacl.signing import SigningKey

from hearme_broker.verify.bridge_client import BridgeVerifyResult
from hearme_broker.verify.credential import issue_delegation_token


# ----- crypto helpers ----------------------------------------------------


@pytest.fixture(scope="session")
def agent_signing_key() -> SigningKey:
    return SigningKey(b"AGENT-KEY-FOR-HEARME-TESTING-32B")


@pytest.fixture(scope="session")
def agent_key_b64(agent_signing_key: SigningKey) -> str:
    return base64.b64encode(agent_signing_key.verify_key.encode()).decode("ascii")


# ----- mocked self-bridge ------------------------------------------------


@pytest.fixture(autouse=True)
def mock_bridge(monkeypatch):
    """Replace the bridge ``verify_self_proof`` call with a deterministic fake.

    Each proof carries a ``_test`` dict that drives the fake's output, so a test
    can steer verified / uniqueIdentifier / nationality / older_than /
    registryConfirmed / boundAgentKey without a real Node bridge or any network.
    """

    async def _fake_verify_self_proof(
        *, bridge_url, attestation_id, proof, public_signals, user_context_data, timeout=30.0
    ):
        t = (proof or {}).get("_test") or {}
        disclosed: dict[str, Any] = {}
        if t.get("nationality") is not None:
            disclosed["nationality"] = t["nationality"]
        if t.get("older_than") is not None:
            disclosed["older_than"] = t["older_than"]
        return BridgeVerifyResult(
            verified=t.get("verified", True),
            unique_identifier=t.get("uniqueIdentifier"),
            disclosed=disclosed,
            bound_agent_key=t.get("boundAgentKey", user_context_data),
            registry_confirmed=t.get("registryConfirmed", True),
        )

    monkeypatch.setattr(
        "hearme_broker.verify.self_identity.verify_self_proof", _fake_verify_self_proof
    )
    return _fake_verify_self_proof


# ----- factories ---------------------------------------------------------


@pytest.fixture
def make_enrollment(agent_key_b64: str) -> Callable[..., dict[str, Any]]:
    """Build an EnrollmentBundle dict (proto/enrollment.json) for /v1/register.

    The Self proofs are mock-verifiable via the ``_test`` blob the autouse
    ``mock_bridge`` reads.
    """

    def _factory(
        *,
        agent_key: str | None = None,
        unique_identifier: str = "self:nullifier-1",
        nationality: str = "DE",
        thresholds: tuple[int, ...] = (18, 25, 35),
        verified: bool = True,
        registry_confirmed: bool = True,
        bound_agent_key: str | None = None,
        per_proof_nullifier: list[str] | None = None,
    ) -> dict[str, Any]:
        ak = agent_key or agent_key_b64
        proofs = []
        for i, thr in enumerate(thresholds):
            uid = (
                per_proof_nullifier[i]
                if per_proof_nullifier is not None
                else unique_identifier
            )
            proofs.append(
                {
                    "attestationId": 1,
                    "proof": {
                        "_test": {
                            "verified": verified,
                            "uniqueIdentifier": uid,
                            "nationality": nationality,
                            "older_than": thr,
                            "registryConfirmed": registry_confirmed,
                            "boundAgentKey": bound_agent_key if bound_agent_key is not None else ak,
                        }
                    },
                    "publicSignals": [],
                    "userContextData": ak,
                }
            )
        return {"self_proofs": proofs, "agent_key": ak}

    return _factory


@pytest.fixture
def make_token(agent_key_b64: str) -> Callable[..., dict[str, Any]]:
    """Build a broker-issued DelegationToken dict (signed with the dev broker key)."""

    def _factory(
        *,
        unique_identifier: str | None = None,
        disclosed_predicates: dict[str, str] | None = None,
        issued_at: datetime | None = None,
        expires_at: datetime | None = None,
        agent_key: str | None = None,
    ) -> dict[str, Any]:
        now = datetime.now(timezone.utc)
        uid = unique_identifier or "self:" + base64.b64encode(b"\x01" * 32).decode("ascii")
        preds = (
            disclosed_predicates
            if disclosed_predicates is not None
            else {"region": "EU", "age_band": "35-49"}
        )
        token = issue_delegation_token(
            unique_identifier=uid,
            disclosed_predicates=preds,
            agent_key=agent_key or agent_key_b64,
            issued_at=issued_at or (now - timedelta(days=1)),
            expires_at=expires_at or (now + timedelta(days=89)),
        )
        return token.model_dump(mode="json")

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
    """Extensions + every drizzle/migrations/*.sql (baseline + deltas) in lex order.

    Mirrors what production does: docker-entrypoint-initdb.d creates the
    pgcrypto extension and applies the generated baseline migration on the
    first boot of a fresh volume, then scripts/migrate.mjs applies any later
    deltas. schema.ts is the single source of truth; the SQL here is generated
    from it. The fixture runs it all in one asyncpg ``execute`` block so the
    schema the broker sees matches prod.
    """

    repo_root = Path(__file__).resolve().parents[3]
    migrations_dir = repo_root / "packages" / "web" / "drizzle" / "migrations"
    parts = ['CREATE EXTENSION IF NOT EXISTS "pgcrypto";']
    for path in sorted(migrations_dir.glob("*.sql")):
        parts.append(path.read_text())
    return "\n".join(parts)


@pytest_asyncio.fixture
async def pg_pool():
    """Spin up an ephemeral Postgres, apply the web schema, yield an asyncpg pool."""
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
