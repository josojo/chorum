"""Per-answer override (§1.12 "override is sacred") — skill side.

Covers:

* ``envelope.build_revocation`` produces a three-field, signed body whose
  signature verifies under the agent_key (and whose digest matches the broker's
  ``revocation_signing_input``).
* The signing domain is separated from envelope signing — a captured envelope
  signature does NOT verify as a revocation.
* ``tools.revoke_answer`` rejects on no/expired delegation without calling the
  broker, and POSTs the right shape on the happy path.
* ``tools.review_my_answers`` is a pure local-ledger read with the expected
  shape and never touches the network.
"""

from __future__ import annotations

import base64
import hashlib
import json
import uuid
from datetime import datetime, timedelta, timezone

import httpx

from hearme_skill.config import Settings
from hearme_skill.crypto.canonical import revocation_payload
from hearme_skill.crypto.ed25519 import generate_keypair, verify
from hearme_skill.crypto.keystore import store_agent_keypair
from hearme_skill.delegation import hash_of, store_delegation
from hearme_skill.envelope import build_envelope, build_revocation
from hearme_skill.tools import review_my_answers, revoke_answer


def _settings(tmp_root) -> Settings:
    return Settings(root_dir=tmp_root, broker_url="http://broker.test")


def _prime_agent_key(settings: Settings):
    kp = generate_keypair()
    store_agent_keypair(settings.agent_key_path, kp)
    return kp


# ----- build_revocation ---------------------------------------------------


def test_build_revocation_has_only_three_fields(agent_keypair, fresh_token):
    body = build_revocation(
        question_id=str(uuid.uuid4()),
        delegation_token=fresh_token,
        agent_key=agent_keypair,
    )
    # Boundary-leakage check: NO answer text, NO question text, NO rationale.
    assert set(body.keys()) == {"question_id", "delegation_token", "revocation_signature"}


def test_build_revocation_signature_verifies(agent_keypair, fresh_token):
    qid = str(uuid.uuid4())
    body = build_revocation(
        question_id=qid,
        delegation_token=fresh_token,
        agent_key=agent_keypair,
    )
    sig = base64.b64decode(body["revocation_signature"])
    dhash = hash_of(fresh_token).hex()
    payload = revocation_payload(qid, dhash)
    assert verify(agent_keypair.public_bytes, payload, sig) is True


def test_revocation_payload_domain_separated_from_envelope(agent_keypair, fresh_token):
    """The whole point of the ``REVOKE`` prefix: an envelope signature must
    NOT verify as a revocation, and vice versa."""
    qid = str(uuid.uuid4())
    env = build_envelope(
        question_id=qid,
        answer_text="yes",
        nonce="nonce-z",
        delegation_token=fresh_token,
        agent_key=agent_keypair,
    )
    rev_payload = revocation_payload(qid, hash_of(fresh_token).hex())
    env_sig = base64.b64decode(env.agent_signature)
    # The envelope signature is OVER the envelope digest, NOT the revocation
    # digest, so it must not verify against the revocation payload.
    assert verify(agent_keypair.public_bytes, rev_payload, env_sig) is False


# ----- revoke_answer (tool) ----------------------------------------------


def _revoke_broker(*, accept: bool = True, posted: list | None = None):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/envelopes/revoke" and request.method == "POST":
            if posted is not None:
                posted.append(json.loads(request.content))
            return httpx.Response(
                200, json={"accepted": accept, "reason": "ok" if accept else "rejected"}
            )
        return httpx.Response(404, json={"reason": "unexpected"})

    return httpx.MockTransport(handler)


def test_revoke_answer_happy_path(tmp_root, fresh_token):
    settings = _settings(tmp_root)
    store_delegation(settings.delegation_path, fresh_token)
    _prime_agent_key(settings)
    qid = str(uuid.uuid4())
    posted: list[dict] = []

    result = revoke_answer(qid, settings=settings, transport=_revoke_broker(posted=posted))

    assert result == {"accepted": True, "reason": "ok", "question_id": qid}
    # The wire body is exactly the three-field shape, and the question_id
    # round-trips. No answer content, no rationale.
    assert len(posted) == 1
    body = posted[0]
    assert set(body.keys()) == {"question_id", "delegation_token", "revocation_signature"}
    assert body["question_id"] == qid


def test_revoke_answer_rejects_when_no_delegation(tmp_root):
    settings = _settings(tmp_root)
    _prime_agent_key(settings)
    # No delegation written.
    posted: list[dict] = []

    result = revoke_answer(
        str(uuid.uuid4()), settings=settings, transport=_revoke_broker(posted=posted)
    )

    assert result["accepted"] is False
    assert result["reason"] == "no-delegation"
    # Critical: we MUST NOT have hit the broker without a usable delegation
    # (otherwise we'd be sending signatures the agent can't authenticate).
    assert posted == []


def test_revoke_answer_rejects_expired_delegation(tmp_root, expired_token):
    settings = _settings(tmp_root)
    store_delegation(settings.delegation_path, expired_token)
    _prime_agent_key(settings)
    posted: list[dict] = []

    result = revoke_answer(
        str(uuid.uuid4()), settings=settings, transport=_revoke_broker(posted=posted)
    )

    assert result["accepted"] is False
    assert result["reason"] == "delegation-expired"
    assert posted == []


def test_revoke_answer_returns_broker_reason_on_reject(tmp_root, fresh_token):
    settings = _settings(tmp_root)
    store_delegation(settings.delegation_path, fresh_token)
    _prime_agent_key(settings)

    result = revoke_answer(
        str(uuid.uuid4()), settings=settings, transport=_revoke_broker(accept=False)
    )

    assert result["accepted"] is False
    assert result["reason"] == "rejected"


# ----- review_my_answers (tool) ------------------------------------------


def test_review_my_answers_empty_when_nothing_submitted(tmp_root):
    settings = _settings(tmp_root)
    result = review_my_answers(settings=settings)
    assert result == {"answers": []}


def test_review_my_answers_returns_local_ledger_only(tmp_root, fresh_token):
    """The review tool must NOT touch the network — it surfaces what the local
    ledger recorded at submit time. We prime the ledger by sending a real
    submission via the tool path, then read it back."""
    from hearme_skill.tools import submit_answer
    from hearme_skill.models import Question

    settings = _settings(tmp_root)
    store_delegation(settings.delegation_path, fresh_token)
    _prime_agent_key(settings)

    # Need a policy that auto-answers our topic.
    settings.policy_path.write_text(
        "auto_answer: true\nmax_answers_per_day: 50\ntopic_allowlist:\n  - coffee\n"
    )

    qid = str(uuid.uuid4())
    question = Question(
        question_id=qid,
        text="Do you like single-origin?",
        topic="coffee",
        created_at=datetime(2026, 5, 19, tzinfo=timezone.utc),
        closes_at=datetime(2099, 1, 1, tzinfo=timezone.utc),
        nonce=base64.b64encode(b"n" * 16).decode("ascii"),
    )

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/questions/open":
            return httpx.Response(200, json=[question.model_dump(mode="json")])
        if request.url.path == "/v1/envelopes":
            return httpx.Response(200, json={"accepted": True, "reason": "ok"})
        return httpx.Response(404, json={"reason": "unexpected"})

    submit_answer(
        qid, "yes — single-origin", settings=settings, transport=httpx.MockTransport(handler)
    )

    # No transport supplied here — proves no network call.
    review = review_my_answers(settings=settings)
    assert len(review["answers"]) == 1
    row = review["answers"][0]
    assert row["question_id"] == qid
    assert row["question_text"] == "Do you like single-origin?"
    assert row["topic"] == "coffee"
    assert row["answer_text"] == "yes — single-origin"
    assert row["accepted"] is True
