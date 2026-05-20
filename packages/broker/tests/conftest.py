"""Shared test fixtures.

A few helpers are shared across most files:
- A deterministic phone signer + agent signer.
- A factory that builds a valid signed DelegationToken.
- A factory that builds a valid signed envelope dict.

The Postgres-dependent suite (test_uniqueness, test_aggregate_recompute)
spins up a real Postgres via ``testcontainers``. If Docker isn't available
those tests skip.
"""

from __future__ import annotations

import base64
import os
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

import asyncpg
import pytest
import pytest_asyncio
from nacl.signing import SigningKey

from hearme_broker.verify.canonical import canonical_json


# ----- crypto helpers ----------------------------------------------------


@pytest.fixture(scope="session")
def phone_signing_key() -> SigningKey:
    # Deterministic across the run; tests assert on the corresponding pubkey.
    return SigningKey(b"PHONE-KEY-FOR-HEARME-TESTING-32B")


@pytest.fixture(scope="session")
def zk_issuer_signing_key() -> SigningKey:
    return SigningKey(b"ZK-ISSUER-KEY-FOR-HEARME-TESTING")


ZK_TEST_ISSUER_KEY_ID = "icao-csca-test-suite"


@pytest.fixture(scope="session", autouse=True)
def install_phone_pubkey(
    phone_signing_key: SigningKey, zk_issuer_signing_key: SigningKey
):
    """Resolve well-known pubkeys to our test keys for the whole session."""
    raw = phone_signing_key.verify_key.encode()
    os.environ["HEARME_PHONE_PUBKEY_BASE64"] = base64.b64encode(raw).decode("ascii")
    issuer_raw = zk_issuer_signing_key.verify_key.encode()
    os.environ["HEARME_ZK_ISSUERS"] = (
        f"{ZK_TEST_ISSUER_KEY_ID}:{base64.b64encode(issuer_raw).decode('ascii')}"
    )
    yield


@pytest.fixture(scope="session")
def agent_signing_key() -> SigningKey:
    return SigningKey(b"AGENT-KEY-FOR-HEARME-TESTING-32B")


# ----- token + envelope factories ---------------------------------------


@pytest.fixture
def make_zk_proof(
    zk_issuer_signing_key: SigningKey,
) -> Callable[..., dict[str, Any]]:
    """Build a valid issuer-signed ZkPassportProof dict.

    Mirrors what mock-phone does, but keyed to the test issuer key so the
    broker accepts it under ``HEARME_ZK_ISSUERS``. Tests can override any
    field to construct adversarial proofs.
    """
    from hearme_broker.verify.zkpassport import mint_zkpassport_proof

    def _factory(
        *,
        agent_key_b64: str,
        nullifier_b64: str,
        disclosed: dict[str, str],
        issued_at: datetime | None = None,
        expires_at: datetime | None = None,
        scope: str = "hearme.network|v1",
        issuer_key_id: str = ZK_TEST_ISSUER_KEY_ID,
        scheme: str = "zkpassport.v1.test",
    ) -> dict[str, Any]:
        now = datetime.now(timezone.utc)
        return mint_zkpassport_proof(
            issuer_signing_key=zk_issuer_signing_key,
            issuer_key_id=issuer_key_id,
            nullifier_b64=nullifier_b64,
            agent_key_b64=agent_key_b64,
            disclosed_predicates=disclosed,
            issued_at=issued_at or now - timedelta(minutes=1),
            expires_at=expires_at or now + timedelta(days=90),
            scope=scope,
            scheme=scheme,
        )

    return _factory


@pytest.fixture
def make_token(
    phone_signing_key: SigningKey,
    agent_signing_key: SigningKey,
    make_zk_proof: Callable[..., dict[str, Any]],
) -> Callable[..., dict[str, Any]]:
    """Build a valid DelegationToken dict (phone-signed, with a valid ZK proof)."""
    from hearme_broker.verify.zkpassport import pack_proof

    def _factory(
        *,
        unique_identifier: str | None = None,
        disclosed_predicates: dict[str, str] | None = None,
        issued_at: datetime | None = None,
        expires_at: datetime | None = None,
        agent_pubkey: bytes | None = None,
        zk_proof_override: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        now = datetime.now(timezone.utc)
        token_expires = (expires_at or now + timedelta(days=89)).astimezone(
            timezone.utc
        )

        uid = unique_identifier or base64.b64encode(b"\x01" * 32).decode("ascii")
        predicates = disclosed_predicates or {"region": "EU", "age_band": "25-34"}
        agent_b64 = base64.b64encode(
            agent_pubkey or agent_signing_key.verify_key.encode()
        ).decode("ascii")

        if zk_proof_override is not None:
            proof = zk_proof_override
        else:
            proof = make_zk_proof(
                agent_key_b64=agent_b64,
                nullifier_b64=uid,
                disclosed=predicates,
                issued_at=now - timedelta(minutes=1),
                # Proof must outlive token.
                expires_at=token_expires + timedelta(minutes=5),
            )

        token = {
            "version": 1,
            "zkpassport_proof": pack_proof(proof),
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
        # Sign the canonical-JSON of the token-without-signature.
        signing_input = canonical_json(token)
        signature = phone_signing_key.sign(signing_input).signature
        token["phone_signature"] = base64.b64encode(signature).decode("ascii")
        return token

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
        dsn = container.get_connection_url().replace("postgresql+psycopg2://", "postgres://")
        # Wait for readiness via a quick connection.
        pool = await asyncpg.create_pool(dsn=dsn, min_size=1, max_size=4)
        async with pool.acquire() as conn:
            await conn.execute(_read_schema())
        yield pool
        await pool.close()
    finally:
        container.stop()
