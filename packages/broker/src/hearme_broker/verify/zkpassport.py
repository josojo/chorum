"""Real zkPassport SNARK verification.

Replaces the v0.2 Ed25519 "issuer signature" stand-in. The broker delegates the
UltraHonk proof check to the Node ``zkpassport-bridge`` (no pure-Python
verifier exists for zkPassport's Noir/UltraHonk proofs), then validates every
``DelegationToken`` claim against the verified outputs.

Checks (all must pass; first failure raises ``VerifyZkPassportError``):

  1. ``zkpassport_proof`` is base64 of canonical-JSON of a bundle
     ``{version, proofs, query, queryResult, scope}`` (parses cleanly).
  2. ``bundle.query.bind.custom_data == token.agent_key`` — the proof is bound
     to *this* agent key (explicit check for a clear reason; the SNARK enforces
     it too, so a swapped agent_key also fails verification).
  3. ``bundle.scope == token.scope``.
  4. The bridge verifies the proof (real SNARK) and returns ``verified=true``.
  5. The verified ``uniqueIdentifier == token.unique_identifier`` (nullifier).
  6. The bridge-derived disclosed predicates ``== token.disclosed_predicates``.

A captured proof reused with a different agent_key fails (2) and (4); tampered
disclosures fail (6); a wrong nullifier fails (5).
"""

from __future__ import annotations

import base64
import binascii
import json
from dataclasses import dataclass
from typing import Any

from ..config import Settings, get_settings
from ..models.schemas import DelegationToken, RejectionReason
from .bridge_client import BridgeError, verify_bundle


class VerifyZkPassportError(Exception):
    """Raised by :func:`verify_zkpassport_proof` when a check fails."""

    def __init__(self, reason: RejectionReason, detail: str = "") -> None:
        super().__init__(f"{reason.value}: {detail}" if detail else reason.value)
        self.reason = reason
        self.detail = detail


@dataclass(frozen=True)
class VerifiedZkPassport:
    """Outputs a verified proof yields, handed back so callers don't re-parse."""

    unique_identifier: str
    disclosed: dict[str, str]
    bundle: dict[str, Any]


_REQUIRED_BUNDLE_KEYS = ("proofs", "query", "queryResult", "scope")


def _parse_bundle(b64_blob: str) -> dict[str, Any]:
    try:
        raw = base64.b64decode(b64_blob, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise VerifyZkPassportError(
            RejectionReason.ZKPASSPORT_PROOF_MALFORMED,
            f"base64 decode failed: {exc}",
        ) from exc
    try:
        bundle = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise VerifyZkPassportError(
            RejectionReason.ZKPASSPORT_PROOF_MALFORMED,
            f"json parse failed: {exc}",
        ) from exc
    if not isinstance(bundle, dict):
        raise VerifyZkPassportError(
            RejectionReason.ZKPASSPORT_PROOF_MALFORMED, "bundle is not an object"
        )
    for key in _REQUIRED_BUNDLE_KEYS:
        if key not in bundle:
            raise VerifyZkPassportError(
                RejectionReason.ZKPASSPORT_PROOF_MALFORMED,
                f"bundle missing {key!r}",
            )
    if not isinstance(bundle["proofs"], list) or not bundle["proofs"]:
        raise VerifyZkPassportError(
            RejectionReason.ZKPASSPORT_PROOF_MALFORMED,
            "bundle.proofs must be a non-empty array",
        )
    return bundle


def _bound_agent_key(bundle: dict[str, Any]) -> Any:
    query = bundle.get("query") or {}
    bind = query.get("bind") or {}
    return bind.get("custom_data")


async def verify_zkpassport_proof(
    token: DelegationToken,
    *,
    settings: Settings | None = None,
) -> VerifiedZkPassport:
    """Run the full proof-verification pipeline (async — calls the bridge)."""
    settings = settings or get_settings()
    bundle = _parse_bundle(token.zkpassport_proof)

    # Step 2: agent-key binding (explicit, for a clear rejection reason).
    if _bound_agent_key(bundle) != token.agent_key:
        raise VerifyZkPassportError(
            RejectionReason.ZKPASSPORT_AGENT_BINDING_MISMATCH,
            "bundle.query.bind.custom_data does not equal token.agent_key",
        )

    # Step 3: scope binding.
    if bundle.get("scope") != token.scope:
        raise VerifyZkPassportError(
            RejectionReason.ZKPASSPORT_SCOPE_MISMATCH,
            f"bundle.scope={bundle.get('scope')!r} expected {token.scope!r}",
        )

    # Step 4: real SNARK verification via the bridge.
    try:
        result = await verify_bundle(
            bridge_url=settings.zkpassport_bridge_url,
            proofs=bundle["proofs"],
            query=bundle["query"],
            query_result=bundle["queryResult"],
            timeout=settings.zkpassport_verify_timeout_seconds,
        )
    except BridgeError as exc:
        raise VerifyZkPassportError(
            RejectionReason.ZKPASSPORT_BRIDGE_ERROR, str(exc)
        ) from exc

    if not result.verified or not result.unique_identifier:
        raise VerifyZkPassportError(
            RejectionReason.ZKPASSPORT_PROOF_INVALID,
            "bridge reported the proof did not verify",
        )

    # Defense in depth: the bridge re-derived the bound key from the same query.
    if (
        result.bound_agent_key is not None
        and result.bound_agent_key != token.agent_key
    ):
        raise VerifyZkPassportError(
            RejectionReason.ZKPASSPORT_AGENT_BINDING_MISMATCH,
            "verified bound agent_key does not equal token.agent_key",
        )

    # Step 5: nullifier binding.
    if result.unique_identifier != token.unique_identifier:
        raise VerifyZkPassportError(
            RejectionReason.ZKPASSPORT_NULLIFIER_MISMATCH,
            "verified uniqueIdentifier does not equal token.unique_identifier",
        )

    # Step 6: predicate binding.
    if result.disclosed != token.disclosed_predicates:
        raise VerifyZkPassportError(
            RejectionReason.ZKPASSPORT_PREDICATES_MISMATCH,
            "verified disclosed predicates do not equal token.disclosed_predicates",
        )

    return VerifiedZkPassport(
        unique_identifier=result.unique_identifier,
        disclosed=result.disclosed,
        bundle=bundle,
    )
