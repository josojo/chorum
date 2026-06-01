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
    pip install pynacl httpx   # the only two deps this script needs
    python scripts/dev-seed-identities.py --broker-url http://localhost:8000 --n 40

The skill itself is now the Rust crate in packages/skill; this script inlines the
same canonical-JSON + envelope signing (verified byte-identical against the
broker's golden vectors) so the envelopes match what a real agent would send.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import random
import sys
from typing import Any

import httpx
from nacl.signing import SigningKey

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


# --- inlined canonical-JSON + envelope signing (matches packages/skill Rust) --


def _canonical_json(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _delegation_hash_hex(token: dict) -> str:
    return hashlib.sha256(_canonical_json(token)).hexdigest()


def _build_envelope(*, signing_key: SigningKey, question_id: str, answer_text: str, nonce: str, token: dict) -> dict:
    dhash_hex = _delegation_hash_hex(token)
    payload = hashlib.sha256(
        b"|".join(p.encode("utf-8") for p in (question_id, answer_text, nonce, dhash_hex))
    ).digest()
    sig = signing_key.sign(payload).signature
    return {
        "question_id": question_id,
        "answer": answer_text,
        "nonce": nonce,
        "delegation_token": token,
        "agent_signature": base64.b64encode(sig).decode("ascii"),
    }


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
        questions = client.get(f"{base}/v1/questions/open").json()
        if not questions:
            print("no open questions — seed the DB first (db/init/03-seed.sql).", file=sys.stderr)
            return 2
        print(f"{len(questions)} open questions; creating {args.n} identities...")

        created = 0
        accepted = 0
        rejected: dict[str, int] = {}
        for _ in range(args.n):
            sk = SigningKey.generate()
            agent_b64 = base64.b64encode(bytes(sk.verify_key)).decode("ascii")
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
            token = ack["delegation_token"]
            region = (token.get("disclosed_predicates") or {}).get("region", "?")
            created += 1

            for question in questions:
                env = _build_envelope(
                    signing_key=sk,
                    question_id=question["question_id"],
                    answer_text=_answer_for(rng, region, question["question_id"]),
                    nonce=question["nonce"],
                    token=token,
                )
                resp = client.post(f"{base}/v1/envelopes", json=env)
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
