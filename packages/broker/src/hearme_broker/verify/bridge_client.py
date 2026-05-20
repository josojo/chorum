"""HTTP client for the zkpassport-bridge ``POST /verify`` endpoint.

The bridge (packages/zkpassport-bridge) is the only component that can run the
real Noir/UltraHonk verifier (@aztec/bb.js), so the broker delegates the
cryptographic proof check to it. Everything else — the binding checks against
the DelegationToken claims — stays in Python (see ``verify/zkpassport.py``).

The broker MUST point at a bridge instance it controls; never trust
verification done by the agent.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx


class BridgeError(Exception):
    """The bridge was unreachable or returned a non-200 / malformed response."""


@dataclass(frozen=True)
class BridgeVerifyResult:
    verified: bool
    unique_identifier: str | None
    disclosed: dict[str, str]
    bound_agent_key: str | None


async def verify_bundle(
    *,
    bridge_url: str,
    proofs: list[Any],
    query: dict[str, Any],
    query_result: dict[str, Any],
    timeout: float = 30.0,
) -> BridgeVerifyResult:
    """Call the bridge to verify a zkPassport bundle. Raises ``BridgeError``
    on transport / protocol failures (distinct from a clean ``verified=false``)."""
    payload = {"proofs": proofs, "query": query, "queryResult": query_result}
    url = f"{bridge_url.rstrip('/')}/verify"
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(url, json=payload)
    except httpx.HTTPError as exc:
        raise BridgeError(f"bridge request to {url} failed: {exc}") from exc

    if resp.status_code != 200:
        raise BridgeError(
            f"bridge returned HTTP {resp.status_code}: {resp.text[:200]}"
        )
    try:
        data = resp.json()
    except ValueError as exc:
        raise BridgeError(f"bridge returned non-JSON body: {exc}") from exc

    disclosed = data.get("disclosed")
    return BridgeVerifyResult(
        verified=bool(data.get("verified")),
        unique_identifier=data.get("uniqueIdentifier"),
        disclosed=disclosed if isinstance(disclosed, dict) else {},
        bound_agent_key=data.get("boundAgentKey"),
    )
