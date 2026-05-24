#!/usr/bin/env python3
"""Create N synthetic identities and answer open questions — phone-free e2e.

DANGER / testing only. Requires the broker running with
``HEARME_BROKER_DEV_INSECURE_REGISTER=1`` (mounts ``POST /v1/dev/register``,
which mints DelegationTokens without any Self proof). This exercises the FULL
answer→aggregate pipeline with real Ed25519 keys + signed envelopes; only the
Self proof-of-personhood step is bypassed.

For each identity it:
  1. generates a real Ed25519 agent keypair,
  2. registers a synthetic nullifier + nationality/age via /v1/dev/register,
  3. signs + submits an Envelope for every open question (real /v1/envelopes).

Run (from repo root), pointing at a dev broker:
    packages/skill/.venv/bin/python scripts/dev-seed-identities.py \
        --broker-url http://localhost:8000 --n 40

Reuses the skill's crypto + envelope code so the envelopes are byte-identical to
what a real agent would send.
"""

from __future__ import annotations

import argparse
import base64
import random
import sys

import httpx

from hearme_skill.crypto.ed25519 import generate_keypair
from hearme_skill.envelope import build_envelope
from hearme_skill.models import DelegationToken, Question

# A spread across continents so region/country aggregates + the map look alive.
NATIONALITIES = [
    "US", "CA", "MX",            # NA
    "DE", "FR", "GB", "ES", "PL",  # EU
    "JP", "CN", "IN", "KR",      # AS
    "BR", "AR", "CO",            # SA
    "NG", "ZA", "KE",            # AF
    "AU", "NZ",                  # OC
]
AGE_LADDER = [18, 25, 35, 50, 65]


def _ladder_up_to(threshold: int) -> list[int]:
    return [t for t in AGE_LADDER if t <= threshold]


def _answer_for(rng: random.Random, region: str, question_id: str) -> str:
    # Per (region, question) bias so the map shows variation, not 50/50 noise.
    bias = random.Random(f"{region}:{question_id}").uniform(0.25, 0.75)
    if rng.random() < bias:
        return "Yes, this reflects my view."
    return "No, that does not reflect my view."


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="dev-seed-identities.py")
    ap.add_argument("--broker-url", default="http://localhost:8000")
    ap.add_argument("--n", type=int, default=40, help="number of synthetic identities")
    ap.add_argument("--seed", type=int, default=1234)
    args = ap.parse_args(argv)

    rng = random.Random(args.seed)
    base = args.broker_url.rstrip("/")

    with httpx.Client(timeout=30.0) as client:
        # Confirm the dev bypass is actually mounted before doing work.
        questions_raw = client.get(f"{base}/v1/questions/open").json()
        questions = [Question.model_validate(q) for q in questions_raw]
        if not questions:
            print("no open questions — seed the DB first (db/init/03-seed.sql).", file=sys.stderr)
            return 2
        print(f"{len(questions)} open questions; creating {args.n} identities...")

        created = 0
        accepted = 0
        rejected: dict[str, int] = {}
        for _ in range(args.n):
            kp = generate_keypair()
            agent_b64 = base64.b64encode(kp.public_bytes).decode("ascii")
            nationality = rng.choice(NATIONALITIES)
            threshold = rng.choice(AGE_LADDER)

            reg = client.post(
                f"{base}/v1/dev/register",
                json={
                    "agent_key": agent_b64,
                    "nationality": nationality,
                    "satisfied_thresholds": _ladder_up_to(threshold),
                },
            )
            if reg.status_code == 404:
                print(
                    "POST /v1/dev/register is 404 — start the broker with "
                    "HEARME_BROKER_DEV_INSECURE_REGISTER=1.",
                    file=sys.stderr,
                )
                return 2
            ack = reg.json()
            if not ack.get("accepted"):
                rejected[f"register:{ack.get('reason')}"] = rejected.get(f"register:{ack.get('reason')}", 0) + 1
                continue
            token = DelegationToken.model_validate(ack["delegation_token"])
            region = token.disclosed_predicates.get("region", "?")
            created += 1

            for question in questions:
                env = build_envelope(
                    question_id=question.question_id,
                    answer_text=_answer_for(rng, region, question.question_id),
                    nonce=question.nonce,
                    delegation_token=token,
                    agent_key=kp,
                )
                resp = client.post(f"{base}/v1/envelopes", json=env.model_dump(mode="json"))
                body = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
                if body.get("accepted"):
                    accepted += 1
                else:
                    key = f"envelope:{body.get('reason') or resp.status_code}"
                    rejected[key] = rejected.get(key, 0) + 1

        print(f"\nidentities created: {created}/{args.n}")
        print(f"envelopes accepted: {accepted}")
        if rejected:
            print("rejections:")
            for k, v in sorted(rejected.items()):
                print(f"  {k}: {v}")

        try:
            stats = client.get(f"{base}/v1/stats").json()
            print("\n/v1/stats:", stats)
        except Exception as exc:  # noqa: BLE001
            print(f"(could not fetch /v1/stats: {exc})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
