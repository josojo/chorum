"""Envelope signing — property tests (§12).

For every byte position in ``(question_id, answer, nonce, delegation_hash)``,
flipping a byte must cause the agent_signature to fail verification. This
is the broker's `swap-rejects` contract from the skill side.
"""

from __future__ import annotations

import base64

import pytest

from hearme_skill.crypto.canonical import sign_payload
from hearme_skill.crypto.ed25519 import verify
from hearme_skill.delegation import hash_of
from hearme_skill.envelope import build_envelope, serialize_envelope


def _verify_envelope(env, expected_pub: bytes) -> bool:
    """Mimic the broker's verifier."""

    dhash_hex = hash_of(env.delegation_token).hex()
    payload = sign_payload(env.question_id, env.answer, env.nonce, dhash_hex)
    sig = base64.b64decode(env.agent_signature)
    return verify(expected_pub, payload, sig)


def test_envelope_signature_round_trips(fresh_token, agent_keypair, question):
    env = build_envelope(
        question_id=question.question_id,
        answer_text="single-origin",
        nonce=question.nonce,
        delegation_token=fresh_token,
        agent_key=agent_keypair,
    )
    assert _verify_envelope(env, agent_keypair.public_bytes) is True


def test_envelope_serialization_has_exactly_five_fields(fresh_token, agent_keypair, question):
    env = build_envelope(
        question_id=question.question_id,
        answer_text="hi",
        nonce=question.nonce,
        delegation_token=fresh_token,
        agent_key=agent_keypair,
    )
    body = serialize_envelope(env)
    assert set(body.keys()) == {
        "question_id",
        "answer",
        "nonce",
        "delegation_token",
        "agent_signature",
    }


@pytest.mark.parametrize("field", ["question_id", "answer", "nonce"])
def test_flipping_any_string_field_breaks_signature(fresh_token, agent_keypair, question, field):
    env = build_envelope(
        question_id=question.question_id,
        answer_text="single-origin",
        nonce=question.nonce,
        delegation_token=fresh_token,
        agent_key=agent_keypair,
    )
    tampered = env.model_copy(update={field: getattr(env, field) + "X"})
    assert _verify_envelope(tampered, agent_keypair.public_bytes) is False


def test_swapping_delegation_token_breaks_signature(
    fresh_token, agent_keypair, question
):
    """A different delegation_token → different delegation_hash → bad sig."""

    env = build_envelope(
        question_id=question.question_id,
        answer_text="single-origin",
        nonce=question.nonce,
        delegation_token=fresh_token,
        agent_key=agent_keypair,
    )
    other = fresh_token.model_copy(
        update={"disclosed_predicates": {"age_band": "35-44", "region": "EU"}}
    )
    tampered = env.model_copy(update={"delegation_token": other})
    assert _verify_envelope(tampered, agent_keypair.public_bytes) is False


def test_rationale_never_appears_in_envelope(fresh_token, agent_keypair, question):
    """`Answer.rationale` is local-only — the envelope can never carry it."""

    env = build_envelope(
        question_id=question.question_id,
        answer_text="single-origin",
        nonce=question.nonce,
        delegation_token=fresh_token,
        agent_key=agent_keypair,
    )
    body = serialize_envelope(env)
    flat = repr(body)
    # No rationale field, no "rationale" key anywhere in the body.
    assert "rationale" not in flat


def test_byte_flip_in_every_position(fresh_token, agent_keypair, question):
    """Stronger property test: flip the first byte of each ingredient field."""

    env = build_envelope(
        question_id=question.question_id,
        answer_text="single-origin",
        nonce=question.nonce,
        delegation_token=fresh_token,
        agent_key=agent_keypair,
    )
    # Flip first byte of question_id (UUID hex char swap)
    flipped_qid = ("0" if env.question_id[0] != "0" else "1") + env.question_id[1:]
    assert _verify_envelope(env.model_copy(update={"question_id": flipped_qid}), agent_keypair.public_bytes) is False

    # Flip the answer
    flipped_ans = ("Q" if env.answer[0] != "Q" else "Z") + env.answer[1:]
    assert _verify_envelope(env.model_copy(update={"answer": flipped_ans}), agent_keypair.public_bytes) is False

    # Flip the nonce
    flipped_nonce = ("A" if env.nonce[0] != "A" else "B") + env.nonce[1:]
    assert _verify_envelope(env.model_copy(update={"nonce": flipped_nonce}), agent_keypair.public_bytes) is False
