"""Verification primitives — see ARCHITECTURE.md §5."""

from .bridge_client import BridgeError, BridgeVerifyResult, verify_bundle
from .canonical import canonical_json, delegation_hash
from .delegation import VerifyDelegationError, verify_delegation
from .envelope import (
    VerifyEnvelopeError,
    envelope_signing_input,
    verify_agent_signature,
)
from .zkpassport import (
    VerifyZkPassportError,
    verify_zkpassport_proof,
)

__all__ = [
    "canonical_json",
    "delegation_hash",
    "BridgeError",
    "BridgeVerifyResult",
    "verify_bundle",
    "VerifyDelegationError",
    "verify_delegation",
    "VerifyEnvelopeError",
    "envelope_signing_input",
    "verify_agent_signature",
    "VerifyZkPassportError",
    "verify_zkpassport_proof",
]
