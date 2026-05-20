#!/usr/bin/env python3
"""Build a DelegationToken from a captured zkpassport-bridge result.

Replaces the old ``mock-phone.py``. There is no more phone-signed token: a
DelegationToken now just wraps a real zkPassport bundle, and its integrity
comes from the SNARK (the broker re-verifies it via the zkpassport-bridge).

So this script does no cryptography — it reassembles JSON. Capture a bundle
once by scanning a **mock passport** (zkPassport app, devMode) against the QR
from the bridge's ``POST /requests``, then save the bridge's
``GET /requests/<id>`` response. Replay it offline with this script:

    # 1. capture (one time), e.g.:
    #    curl -s localhost:8787/requests/<id> > fixture.json
    # 2. replay into a DelegationToken:
    ./scripts/mock-onboard.py --from-bridge fixture.json > delegation.token

The bundle is bound (in-circuit) to a specific agent_key, so the agent that
replays it MUST own the matching agent private key. The token's ``agent_key``
is read straight from the bundle's ``query.bind.custom_data``.

Usage:
    mock-onboard.py --from-bridge <file|->  [--ttl-days N]   > delegation.token
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
from datetime import datetime, timedelta, timezone
from typing import Any


def _canonical_json_bytes(value: Any) -> bytes:
    # Mirrors packages/{broker,skill} canonical JSON for non-datetime values:
    # sorted keys (recursive), no whitespace, ensure_ascii=False.
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")


def _iso_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _read(arg: str) -> str:
    if arg == "-":
        return sys.stdin.read()
    with open(arg, encoding="utf-8") as fh:
        return fh.read()


def build_token(bridge_result: dict[str, Any], *, ttl_days: int) -> dict[str, Any]:
    if not bridge_result.get("verified"):
        raise SystemExit(
            "bridge result is not verified=true; capture a verified proof first"
        )
    bundle = bridge_result.get("bundle")
    if not isinstance(bundle, dict):
        raise SystemExit("bridge result missing 'bundle' object")
    unique_identifier = bridge_result.get("uniqueIdentifier")
    if not unique_identifier:
        raise SystemExit("bridge result missing 'uniqueIdentifier'")
    disclosed = bridge_result.get("disclosed") or {}

    agent_key = (
        ((bundle.get("query") or {}).get("bind") or {}).get("custom_data")
    )
    if not agent_key:
        raise SystemExit("bundle.query.bind.custom_data (agent_key) missing")

    now = datetime.now(timezone.utc)
    return {
        "version": 1,
        "zkpassport_proof": base64.b64encode(_canonical_json_bytes(bundle)).decode(
            "ascii"
        ),
        "domain": "hearme.network",
        "scope": "v1",
        "unique_identifier": unique_identifier,
        "disclosed_predicates": disclosed,
        "agent_key": agent_key,
        "issued_at": _iso_z(now),
        "expires_at": _iso_z(now + timedelta(days=ttl_days)),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="mock-onboard.py")
    parser.add_argument(
        "--from-bridge",
        required=True,
        help="Path to a captured GET /requests/<id> JSON, or '-' for stdin.",
    )
    parser.add_argument("--ttl-days", type=int, default=90)
    args = parser.parse_args(argv)

    bridge_result = json.loads(_read(args.from_bridge))
    token = build_token(bridge_result, ttl_days=args.ttl_days)
    json.dump(token, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
