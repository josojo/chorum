"""Verification primitives — see ARCHITECTURE.md §5."""

from .bridge_client import BridgeError, BridgeVerifyResult, verify_self_proof
from .canonical import canonical_json, delegation_hash
from .credential import issue_delegation_token, verify_broker_signature
from .delegation import VerifyDelegationError, verify_delegation
from .envelope import (
    VerifyEnvelopeError,
    envelope_signing_input,
    revocation_signing_input,
    verify_agent_signature,
    verify_revocation_signature,
)
from .predicates import (
    PredicateError,
    country_to_region,
    derive_predicates,
    thresholds_to_age_band,
)
from .self_identity import (
    VerifiedEnrollment,
    VerifyEnrollmentError,
    verify_enrollment,
)

__all__ = [
    "canonical_json",
    "delegation_hash",
    "BridgeError",
    "BridgeVerifyResult",
    "verify_self_proof",
    "issue_delegation_token",
    "verify_broker_signature",
    "VerifyDelegationError",
    "verify_delegation",
    "VerifyEnvelopeError",
    "envelope_signing_input",
    "revocation_signing_input",
    "verify_agent_signature",
    "verify_revocation_signature",
    "PredicateError",
    "country_to_region",
    "thresholds_to_age_band",
    "derive_predicates",
    "VerifiedEnrollment",
    "VerifyEnrollmentError",
    "verify_enrollment",
]
