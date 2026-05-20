#!/usr/bin/env python3
"""Mock phone — issues a DelegationToken signed with the dev phone key.

Per ARCHITECTURE.md §9 + §8.5 + IDENTITY.md. Used by the skill container's
auto-onboarding flow and by hand for local testing.

Two deterministic dev keypairs:
  * **phone**   seed = bytes([1] * 32) — signs the DelegationToken bundle
    (matches broker's ``well_known.phone_pubkey_base64()``).
  * **issuer** seed = bytes([2] * 32), key id ``icao-csca-test-2026`` —
    signs the ``ZkPassportProof`` embedded in ``zkpassport_proof``
    (matches broker's ``well_known.zk_issuer_pubkey_base64()``).

The "issuer" is a stand-in for an ICAO CSCA whose Ed25519 signature stands
in for SNARK verification of a real zkPassport circuit. The structural
shape (nullifier, agent_key_commitment, predicate_commitment, scope, disclosed)
is what a real proof would carry, and the broker checks each binding.

Usage:
    mock-phone.py mint --agent-pubkey-b64 <b64> [--unique-id <str>]
                       [--profile minimal|standard|granular]
                       [--ttl-days N]   > delegation.json

    mock-phone.py mint-zkpassport --agent-pubkey-b64 <b64>
                       [--unique-id <str>] [--profile ...]
                       [--ttl-days N]   > zkproof.json
                       # forwards just the inner ZkPassportProof, useful for
                       # demoing how the phone's "identity bundle" looks.

    mock-phone.py pubkey            # prints the dev phone public key (base64)
    mock-phone.py issuer-pubkey     # prints the dev issuer public key (base64)
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import sys
from datetime import datetime, timedelta, timezone
from typing import Any

try:
    from nacl.signing import SigningKey
except ImportError:
    sys.stderr.write(
        "mock-phone.py needs pynacl. Install it with: pip install pynacl\n"
    )
    raise


# Deterministic dev keypairs. The broker's well_known.py hardcodes the
# matching public keys, so signatures verify out of the box.
DEV_PHONE_SEED = bytes([1] * 32)
DEV_ISSUER_SEED = bytes([2] * 32)
DEV_ISSUER_KEY_ID = "icao-csca-test-2026"

# § 8.3 disclosure profiles. Real values would be derived from passport claims;
# here they're plausible defaults for the dev environment.
PROFILES: dict[str, dict[str, str]] = {
    "minimal": {"age_band": "18+", "region": "EU"},
    "standard": {"age_band": "25-34", "region": "EU", "gender": "n/a"},
    "granular": {
        "age_band": "25-34",
        "country": "DEU",
        "gender": "n/a",
        "urban_rural": "urban",
    },
}


# ---- canonical JSON (mirror of packages/broker/verify/canonical.py) -------


def _normalize(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _normalize(value[k]) for k in sorted(value.keys())}
    if isinstance(value, list):
        return [_normalize(v) for v in value]
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.isoformat() + "Z"
        return value.isoformat().replace("+00:00", "Z")
    return value


def canonical_json(obj: Any) -> bytes:
    return json.dumps(
        _normalize(obj),
        separators=(",", ":"),
        ensure_ascii=False,
        sort_keys=True,
    ).encode("utf-8")


# ---- token construction ---------------------------------------------------


def _iso_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _validate_agent_pubkey(agent_pubkey_b64: str) -> bytes:
    try:
        raw_pub = base64.b64decode(agent_pubkey_b64)
    except Exception as exc:
        raise SystemExit(f"--agent-pubkey-b64 is not valid base64: {exc}")
    if len(raw_pub) != 32:
        raise SystemExit(f"--agent-pubkey-b64 decodes to {len(raw_pub)} bytes; want 32")
    return raw_pub


def _scope_for_token() -> str:
    return "hearme.network|v1"


def _compute_unique_identifier(seed: str) -> str:
    digest = hashlib.sha256((seed + "|hearme.network|v1").encode("utf-8")).digest()
    return base64.b64encode(digest).decode("ascii")


def mint_zkpassport_proof(
    *,
    agent_pubkey_b64: str,
    agent_pubkey_raw: bytes,
    unique_identifier: str,
    disclosed_predicates: dict,
    issued_at: datetime,
    expires_at: datetime,
) -> dict:
    """Build the inner ZkPassportProof, signed by the dev issuer key."""

    proof: dict = {
        "version": 1,
        "scheme": "zkpassport.v1.test",
        "issuer_key_id": DEV_ISSUER_KEY_ID,
        "scope": _scope_for_token(),
        "nullifier": unique_identifier,
        "agent_key_commitment": hashlib.sha256(agent_pubkey_raw).hexdigest(),
        "predicate_commitment": hashlib.sha256(
            canonical_json(disclosed_predicates)
        ).hexdigest(),
        "disclosed": disclosed_predicates,
        "issued_at": _iso_z(issued_at),
        "expires_at": _iso_z(expires_at),
    }
    issuer_sk = SigningKey(DEV_ISSUER_SEED)
    sig = issuer_sk.sign(canonical_json(proof)).signature
    proof["issuer_signature"] = base64.b64encode(sig).decode("ascii")
    # Discourage callers from passing the unused arg around.
    _ = agent_pubkey_b64
    return proof


def mint_token(
    *,
    agent_pubkey_b64: str,
    unique_id_seed: str,
    profile: str,
    ttl_days: int,
) -> dict:
    if profile not in PROFILES:
        raise SystemExit(f"unknown profile {profile!r}; choose from {list(PROFILES)}")

    raw_pub = _validate_agent_pubkey(agent_pubkey_b64)
    unique_identifier = _compute_unique_identifier(unique_id_seed)
    disclosed_predicates = PROFILES[profile]

    now = datetime.now(timezone.utc)
    token_expires = now + timedelta(days=ttl_days)
    # Proof expiry must be >= token expiry; give it a small extra grace so
    # the broker's "proof_expires_at >= token_expires_at" check holds even
    # under tiny serialization rounding.
    proof_expires = token_expires + timedelta(minutes=1)

    proof = mint_zkpassport_proof(
        agent_pubkey_b64=agent_pubkey_b64,
        agent_pubkey_raw=raw_pub,
        unique_identifier=unique_identifier,
        disclosed_predicates=disclosed_predicates,
        issued_at=now,
        expires_at=proof_expires,
    )
    zkpassport_proof_b64 = base64.b64encode(canonical_json(proof)).decode("ascii")

    token: dict = {
        "version": 1,
        "zkpassport_proof": zkpassport_proof_b64,
        "domain": "hearme.network",
        "scope": "v1",
        "unique_identifier": unique_identifier,
        "disclosed_predicates": disclosed_predicates,
        "agent_key": agent_pubkey_b64,
        "issued_at": _iso_z(now),
        "expires_at": _iso_z(token_expires),
    }

    signing_key = SigningKey(DEV_PHONE_SEED)
    signature = signing_key.sign(canonical_json(token)).signature
    token["phone_signature"] = base64.b64encode(signature).decode("ascii")
    return token


# ---- CLI ------------------------------------------------------------------


def _cmd_mint(args: argparse.Namespace) -> int:
    token = mint_token(
        agent_pubkey_b64=args.agent_pubkey_b64,
        unique_id_seed=args.unique_id,
        profile=args.profile,
        ttl_days=args.ttl_days,
    )
    json.dump(token, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


def _cmd_pubkey(_: argparse.Namespace) -> int:
    sk = SigningKey(DEV_PHONE_SEED)
    print(base64.b64encode(bytes(sk.verify_key)).decode("ascii"))
    return 0


def _cmd_issuer_pubkey(_: argparse.Namespace) -> int:
    sk = SigningKey(DEV_ISSUER_SEED)
    print(base64.b64encode(bytes(sk.verify_key)).decode("ascii"))
    return 0


def _cmd_mint_zkpassport(args: argparse.Namespace) -> int:
    if args.profile not in PROFILES:
        raise SystemExit(
            f"unknown profile {args.profile!r}; choose from {list(PROFILES)}"
        )
    raw_pub = _validate_agent_pubkey(args.agent_pubkey_b64)
    now = datetime.now(timezone.utc)
    proof = mint_zkpassport_proof(
        agent_pubkey_b64=args.agent_pubkey_b64,
        agent_pubkey_raw=raw_pub,
        unique_identifier=_compute_unique_identifier(args.unique_id),
        disclosed_predicates=PROFILES[args.profile],
        issued_at=now,
        expires_at=now + timedelta(days=args.ttl_days),
    )
    json.dump(proof, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="mock-phone.py")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_mint = sub.add_parser("mint", help="Mint a signed DelegationToken")
    p_mint.add_argument("--agent-pubkey-b64", required=True)
    p_mint.add_argument(
        "--unique-id",
        default="dev-user-1",
        help="Surrogate for the passport secret; same seed → same unique_identifier.",
    )
    p_mint.add_argument("--profile", default="standard", choices=list(PROFILES))
    p_mint.add_argument("--ttl-days", type=int, default=90)
    p_mint.set_defaults(func=_cmd_mint)

    p_pub = sub.add_parser("pubkey", help="Print the dev phone public key")
    p_pub.set_defaults(func=_cmd_pubkey)

    p_ipub = sub.add_parser(
        "issuer-pubkey",
        help="Print the dev zkPassport issuer public key (base64)",
    )
    p_ipub.set_defaults(func=_cmd_issuer_pubkey)

    p_zk = sub.add_parser(
        "mint-zkpassport",
        help="Mint just the inner ZkPassportProof (issuer-signed)",
    )
    p_zk.add_argument("--agent-pubkey-b64", required=True)
    p_zk.add_argument("--unique-id", default="dev-user-1")
    p_zk.add_argument("--profile", default="standard", choices=list(PROFILES))
    p_zk.add_argument("--ttl-days", type=int, default=90)
    p_zk.set_defaults(func=_cmd_mint_zkpassport)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
