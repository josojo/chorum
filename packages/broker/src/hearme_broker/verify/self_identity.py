"""Registration-time Self proof verification (verify-once — ARCHITECTURE.md §5).

Runs at ``POST /v1/register`` only. For each proof in the EnrollmentBundle:

  1. The self-bridge runs the real SNARK (``@selfxyz/core``) and the one-time
     on-chain Celo registry/Merkle-root check (``registryConfirmed``).
  2. Bindings: every proof is bound to ``agent_key`` (== ``userDefinedData``)
     and carries the SAME nullifier (-> ``unique_identifier``).
  3. The broker derives the authoritative ``disclosed_predicates`` (region,
     age_band) from the verified nationality + satisfied age thresholds.

On success the caller binds ``nullifier -> agent_key`` and mints a
DelegationToken. No Self proof is ever touched again after this.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass

from ..config import Settings, get_settings
from ..models.schemas import EnrollmentBundle, RejectionReason
from .bridge_client import BridgeError, verify_self_proof
from .predicates import PredicateError, derive_predicates


class VerifyEnrollmentError(Exception):
    """Raised by :func:`verify_enrollment` when a check fails."""

    def __init__(self, reason: RejectionReason, detail: str = "") -> None:
        super().__init__(f"{reason.value}: {detail}" if detail else reason.value)
        self.reason = reason
        self.detail = detail


@dataclass(frozen=True)
class VerifiedEnrollment:
    unique_identifier: str
    agent_key: str
    disclosed_predicates: dict[str, str]


def _coerce_threshold(value: object) -> int | None:
    if isinstance(value, bool):  # guard: bool is an int subclass
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return None


async def verify_enrollment(
    bundle: EnrollmentBundle, *, settings: Settings | None = None
) -> VerifiedEnrollment:
    """Verify every Self proof and derive the identity. Async (calls the bridge)."""
    settings = settings or get_settings()

    # agent_key must be a usable Ed25519 public key (we verify the agent's
    # per-question signatures against it later).
    try:
        if len(base64.b64decode(bundle.agent_key, validate=True)) != 32:
            raise ValueError("not 32 bytes")
    except Exception as exc:  # noqa: BLE001
        raise VerifyEnrollmentError(
            RejectionReason.ENROLLMENT_MALFORMED, f"agent_key invalid: {exc}"
        ) from exc

    nullifier: str | None = None
    nationality: str | None = None
    satisfied: list[int] = []

    for sp in bundle.self_proofs:
        try:
            result = await verify_self_proof(
                bridge_url=settings.self_bridge_url,
                attestation_id=sp.attestation_id,
                proof=sp.proof,
                public_signals=sp.public_signals,
                user_context_data=sp.user_context_data,
                timeout=settings.self_verify_timeout_seconds,
            )
        except BridgeError as exc:
            raise VerifyEnrollmentError(
                RejectionReason.SELF_BRIDGE_ERROR, str(exc)
            ) from exc

        if not result.verified or not result.unique_identifier:
            raise VerifyEnrollmentError(
                RejectionReason.SELF_PROOF_INVALID, "bridge reported proof did not verify"
            )

        # Sybil hardening: the proof must be anchored to Self's live Celo
        # registry (proves it was built against the real one-passport→one-identity
        # tree, not a forged/stale root). See ARCHITECTURE.md §5.
        if settings.require_registry_confirmation and not result.registry_confirmed:
            raise VerifyEnrollmentError(
                RejectionReason.SELF_REGISTRY_UNCONFIRMED,
                "on-chain registry/root not confirmed",
            )

        # Agent-key bind (the proof commits to userDefinedData == agent_key).
        if (
            result.bound_agent_key is not None
            and result.bound_agent_key != bundle.agent_key
        ):
            raise VerifyEnrollmentError(
                RejectionReason.SELF_AGENT_BINDING_MISMATCH,
                "verified userDefinedData does not equal agent_key",
            )

        # All proofs must be the same human (same scope ⇒ same nullifier).
        if nullifier is None:
            nullifier = result.unique_identifier
        elif result.unique_identifier != nullifier:
            raise VerifyEnrollmentError(
                RejectionReason.SELF_NULLIFIER_MISMATCH,
                "proofs carry different nullifiers",
            )

        nat = result.disclosed.get("nationality")
        if nat:
            if nationality is None:
                nationality = str(nat)
            elif str(nat) != nationality:
                raise VerifyEnrollmentError(
                    RejectionReason.SELF_PROOF_INVALID,
                    "proofs disclose different nationalities",
                )

        threshold = _coerce_threshold(result.disclosed.get("older_than"))
        if threshold is not None:
            satisfied.append(threshold)

    if nullifier is None:  # defensive; loop guarantees at least one proof
        raise VerifyEnrollmentError(RejectionReason.SELF_PROOF_INVALID, "no nullifier")
    if not nationality:
        raise VerifyEnrollmentError(
            RejectionReason.PREDICATE_DERIVATION_FAILED, "no nationality disclosed"
        )

    try:
        predicates = derive_predicates(
            nationality=nationality, satisfied_thresholds=satisfied
        )
    except PredicateError as exc:
        raise VerifyEnrollmentError(
            RejectionReason.PREDICATE_DERIVATION_FAILED, str(exc)
        ) from exc

    return VerifiedEnrollment(
        unique_identifier=nullifier,
        agent_key=bundle.agent_key,
        disclosed_predicates=predicates,
    )
