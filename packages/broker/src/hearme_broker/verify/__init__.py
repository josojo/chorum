"""Verification primitives — see ARCHITECTURE.md §5."""

from .canonical import canonical_json, delegation_hash
from .delegation import VerifyDelegationError, verify_delegation
from .envelope import (
    VerifyEnvelopeError,
    envelope_signing_input,
    verify_agent_signature,
)
from .zkpassport import (
    VerifyZkPassportError,
    mint_zkpassport_proof,
    pack_proof,
    verify_zkpassport_proof,
)

__all__ = [
    "canonical_json",
    "delegation_hash",
    "VerifyDelegationError",
    "verify_delegation",
    "VerifyEnvelopeError",
    "envelope_signing_input",
    "verify_agent_signature",
    "VerifyZkPassportError",
    "mint_zkpassport_proof",
    "pack_proof",
    "verify_zkpassport_proof",
]
