"""HTTP client for the self-bridge ``POST /verify`` endpoint.

The bridge (packages/self-bridge) is the only component that can run
``@selfxyz/core``'s ``SelfBackendVerifier`` (Node-only) and the one-time
on-chain Celo registry/root check. The broker delegates the cryptographic proof
check to it **once, at registration** (``verify/self_identity.py``); everything
else — the binding checks and predicate derivation — stays in Python.

The broker MUST point at a bridge instance it controls; never trust
verification done by the agent.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import httpx


class BridgeError(Exception):
    """The bridge was unreachable or returned a non-200 / malformed response."""


@dataclass(frozen=True)
class BridgeVerifyResult:
    verified: bool
    unique_identifier: str | None
    # Verified disclosures for this single proof: {"nationality": "DE",
    # "older_than": 25}. ``older_than`` is the minimumAge threshold this proof
    # attested (the holder is at least that old).
    disclosed: dict[str, Any]
    bound_agent_key: str | None
    # On-chain confirmation that the proof's Merkle root is live in Self's Celo
    # Identity Registry (Sybil hardening). False when no Celo RPC is configured.
    registry_confirmed: bool = field(default=False)


async def verify_self_proof(
    *,
    bridge_url: str,
    attestation_id: int,
    proof: Any,
    public_signals: list[Any],
    user_context_data: str,
    timeout: float = 30.0,
) -> BridgeVerifyResult:
    """Call the bridge to verify one Self proof bundle. Raises ``BridgeError``
    on transport/protocol failures (distinct from a clean ``verified=false``)."""
    payload = {
        "attestationId": attestation_id,
        "proof": proof,
        "publicSignals": public_signals,
        "userContextData": user_context_data,
    }
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
        registry_confirmed=bool(data.get("registryConfirmed")),
    )
