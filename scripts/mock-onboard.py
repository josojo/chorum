#!/usr/bin/env python3
"""Register a captured self-bridge result with the broker and print the token.

Verify-once (ARCHITECTURE.md §5/§8): a DelegationToken is now ISSUED BY THE
BROKER after it verifies the Self proofs. So this script no longer fabricates a
token — it replays a captured set of proofs through ``POST /v1/register`` and
prints the broker-signed token the broker returns.

Capture a bridge result once by scanning a **mock passport** (Self app, staging)
against the QR codes from the bridge's ``POST /requests``, then save the bridge's
``GET /requests/<id>`` response (it contains ``bundles[]`` and ``boundAgentKey``).
Replay it:

    # 1. capture (one time):  curl -s localhost:8787/requests/<id> > fixture.json
    # 2. register + print the token:
    ./scripts/mock-onboard.py --from-bridge fixture.json \
        --broker-url http://localhost:8000 > delegation.token

The proofs are bound (in-circuit) to a specific agent_key, so the agent that
uses the token MUST own the matching agent private key.

Usage:
    mock-onboard.py --from-bridge <file|-> [--broker-url URL] > delegation.token
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from typing import Any


def _read(arg: str) -> str:
    if arg == "-":
        return sys.stdin.read()
    with open(arg, encoding="utf-8") as fh:
        return fh.read()


def _enrollment_from_bridge(bridge_result: dict[str, Any]) -> dict[str, Any]:
    if not bridge_result.get("verified"):
        raise SystemExit("bridge result is not verified=true; capture verified proofs first")
    bundles = bridge_result.get("bundles")
    if not isinstance(bundles, list) or not bundles:
        raise SystemExit("bridge result missing 'bundles' (the self_proofs[])")
    agent_key = bridge_result.get("boundAgentKey")
    if not agent_key:
        raise SystemExit("bridge result missing 'boundAgentKey' (the agent_key)")
    return {"self_proofs": bundles, "agent_key": agent_key}


def _register(broker_url: str, enrollment: dict[str, Any]) -> dict[str, Any]:
    url = f"{broker_url.rstrip('/')}/v1/register"
    body = json.dumps(enrollment).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, headers={"content-type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            ack = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise SystemExit(f"broker /v1/register HTTP {exc.code}: {exc.read()[:200]!r}")
    except urllib.error.URLError as exc:
        raise SystemExit(f"broker /v1/register unreachable: {exc}")
    if not ack.get("accepted"):
        raise SystemExit(f"broker rejected registration: {ack.get('reason')}")
    token = ack.get("delegation_token")
    if not token:
        raise SystemExit("broker accepted but returned no delegation_token")
    return token


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="mock-onboard.py")
    parser.add_argument(
        "--from-bridge",
        required=True,
        help="Path to a captured GET /requests/<id> JSON, or '-' for stdin.",
    )
    parser.add_argument("--broker-url", default="http://localhost:8000")
    args = parser.parse_args(argv)

    bridge_result = json.loads(_read(args.from_bridge))
    enrollment = _enrollment_from_bridge(bridge_result)
    token = _register(args.broker_url, enrollment)
    json.dump(token, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
