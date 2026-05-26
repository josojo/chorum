"""End-to-end test for the phone-free dev-register bypass.

Drives the *real* HTTP routes against a real (testcontainer) Postgres:

    POST /v1/dev/register  ->  sign an Envelope  ->  POST /v1/envelopes

so it exercises the whole answer→aggregate pipeline the way
``scripts/dev-seed-identities.py`` does, minus the network: synthetic identities
(no Self proof), but real Ed25519 keys, real broker-signed DelegationTokens,
real signature/eligibility/replay checks, and real aggregate writes.

The bypass route is mounted only when ``HEARME_BROKER_DEV_INSECURE_REGISTER=1``;
the fixture sets that before building the app. Postgres comes from the shared
``pg_pool`` fixture (skips cleanly if Docker is absent).
"""

from __future__ import annotations

import base64
import json
import os
import uuid
from datetime import datetime, timedelta, timezone

import httpx
import pytest_asyncio
from nacl.signing import SigningKey

from hearme_broker.verify.canonical import delegation_hash
from hearme_broker.verify.envelope import envelope_signing_input


@pytest_asyncio.fixture
async def dev_client(pg_pool, monkeypatch):
    """App with the dev bypass mounted, its DB pool pointed at the testcontainer.

    Uses ``ASGITransport`` (no lifespan), so the app never runs ``init_pool`` /
    ``close_pool`` — we set the global pool to ``pg_pool`` directly and let the
    fixture own its lifecycle.
    """

    monkeypatch.setenv("HEARME_BROKER_DEV_INSECURE_REGISTER", "1")
    import hearme_broker.db.client as dbclient

    monkeypatch.setattr(dbclient, "_pool", pg_pool)

    from hearme_broker.main import create_app

    transport = httpx.ASGITransport(app=create_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://broker.test") as client:
        yield client


# ----- helpers -----------------------------------------------------------


async def _insert_open_question(
    pg_pool, *, nonce: str, scope: str = "worldwide", country=None, continent=None
) -> uuid.UUID:
    qid = uuid.uuid4()
    async with pg_pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO questions (id, text, nonce, closes_at, status, scope, country, continent)"
            " VALUES ($1, $2, $3, $4, 'open', $5, $6, $7)",
            qid,
            "e2e: do you agree?",
            nonce,
            datetime.now(timezone.utc) + timedelta(hours=1),
            scope,
            country,
            continent,
        )
    return qid


def _new_identity() -> tuple[SigningKey, str]:
    sk = SigningKey(os.urandom(32))
    pub_b64 = base64.b64encode(sk.verify_key.encode()).decode("ascii")
    return sk, pub_b64


async def _dev_register(
    client, *, agent_key_b64, nationality="US", thresholds=(18,), unique_identifier=None
) -> dict:
    payload = {
        "agent_key": agent_key_b64,
        "nationality": nationality,
        "satisfied_thresholds": list(thresholds),
    }
    if unique_identifier is not None:
        payload["unique_identifier"] = unique_identifier
    resp = await client.post("/v1/dev/register", json=payload)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["accepted"] is True, body
    return body["delegation_token"]


def _sign_envelope(signing_key: SigningKey, token: dict, *, question_id, answer, nonce) -> dict:
    dhash = delegation_hash(token)
    digest = envelope_signing_input(question_id, answer, nonce, dhash)
    sig = signing_key.sign(digest).signature
    return {
        "question_id": str(question_id),
        "answer": answer,
        "nonce": nonce,
        "delegation_token": token,
        "agent_signature": base64.b64encode(sig).decode("ascii"),
    }


def _by_predicate(row) -> dict:
    bp = row["by_predicate"]
    return json.loads(bp) if isinstance(bp, str) else bp


# ----- tests -------------------------------------------------------------


async def test_dev_bypass_full_flow_updates_aggregates(dev_client, pg_pool):
    """register (no proof) -> sign -> submit -> accepted -> aggregate written."""
    nonce = "e2e-nonce-happy"
    qid = await _insert_open_question(pg_pool, nonce=nonce)

    sk, pub = _new_identity()
    token = await _dev_register(dev_client, agent_key_b64=pub, nationality="US", thresholds=(18, 25))
    env = _sign_envelope(sk, token, question_id=qid, answer="Yes, strongly agree.", nonce=nonce)

    resp = await dev_client.post("/v1/envelopes", json=env)
    assert resp.status_code == 200, resp.text
    assert resp.json()["accepted"] is True, resp.json()

    async with pg_pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT total_answers, by_predicate FROM aggregates WHERE question_id = $1", qid
        )
    assert row["total_answers"] == 1
    bp = _by_predicate(row)
    # US + max threshold 25 -> region NA, country US, age_band 25-34.
    assert bp.get("country:US") == {"yes": 1, "no": 0}
    assert bp.get("region:NA") == {"yes": 1, "no": 0}
    assert bp.get("age_band:25-34") == {"yes": 1, "no": 0}


async def test_dev_bypass_multiple_identities_tally(dev_client, pg_pool):
    """Several distinct synthetic identities tally yes/no per predicate."""
    nonce = "e2e-nonce-multi"
    qid = await _insert_open_question(pg_pool, nonce=nonce)

    voters = [
        ("US", (18,), "Yes."),
        ("US", (18, 25, 35), "No, disagree."),
        ("DE", (18,), "Yes, agree."),
    ]
    for nationality, thresholds, answer in voters:
        sk, pub = _new_identity()
        token = await _dev_register(
            dev_client, agent_key_b64=pub, nationality=nationality, thresholds=thresholds
        )
        env = _sign_envelope(sk, token, question_id=qid, answer=answer, nonce=nonce)
        resp = await dev_client.post("/v1/envelopes", json=env)
        assert resp.json()["accepted"] is True, resp.json()

    async with pg_pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT total_answers, by_predicate FROM aggregates WHERE question_id = $1", qid
        )
    assert row["total_answers"] == 3
    bp = _by_predicate(row)
    assert bp["country:US"] == {"yes": 1, "no": 1}
    assert bp["country:DE"] == {"yes": 1, "no": 0}
    assert bp["region:NA"] == {"yes": 1, "no": 1}
    assert bp["region:EU"] == {"yes": 1, "no": 0}


async def test_dev_bypass_one_answer_per_identity(dev_client, pg_pool):
    """Same identity answering twice -> second rejected (composite PK), tally stays 1."""
    nonce = "e2e-nonce-dup"
    qid = await _insert_open_question(pg_pool, nonce=nonce)

    sk, pub = _new_identity()
    token = await _dev_register(
        dev_client,
        agent_key_b64=pub,
        nationality="US",
        thresholds=(18,),
        unique_identifier="self:e2e-fixed-nullifier",
    )

    first = await dev_client.post(
        "/v1/envelopes",
        json=_sign_envelope(sk, token, question_id=qid, answer="Yes.", nonce=nonce),
    )
    assert first.json()["accepted"] is True, first.json()

    second = await dev_client.post(
        "/v1/envelopes",
        json=_sign_envelope(sk, token, question_id=qid, answer="No, changed my mind.", nonce=nonce),
    )
    body = second.json()
    assert body["accepted"] is False
    assert body["reason"] == "duplicate"

    async with pg_pool.acquire() as conn:
        total = await conn.fetchval(
            "SELECT total_answers FROM aggregates WHERE question_id = $1", qid
        )
    assert total == 1


async def test_dev_bypass_route_absent_without_flag(monkeypatch):
    """With the flag off the route isn't mounted at all (HTTP 404). No DB needed."""
    monkeypatch.delenv("HEARME_BROKER_DEV_INSECURE_REGISTER", raising=False)
    from hearme_broker.main import create_app

    transport = httpx.ASGITransport(app=create_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://broker.test") as client:
        resp = await client.post(
            "/v1/dev/register",
            json={"agent_key": base64.b64encode(b"\x01" * 32).decode("ascii")},
        )
    assert resp.status_code == 404
