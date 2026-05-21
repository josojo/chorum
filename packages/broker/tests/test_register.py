"""Registration pipeline (POST /v1/register) — verify/self_identity.py.

The self-bridge is mocked (conftest ``mock_bridge``); bindings, predicate
derivation, and the failure reasons run for real.
"""

from __future__ import annotations

import pytest

from hearme_broker.models.schemas import EnrollmentBundle, RejectionReason
from hearme_broker.verify.self_identity import (
    VerifyEnrollmentError,
    verify_enrollment,
)


async def test_happy_path_full_ladder(make_enrollment):
    bundle = EnrollmentBundle.model_validate(
        make_enrollment(nationality="DE", thresholds=(18, 25, 35))
    )
    out = await verify_enrollment(bundle)
    assert out.unique_identifier == "self:nullifier-1"
    assert out.disclosed_predicates == {"region": "EU", "age_band": "35-49"}


async def test_single_18_proof_yields_18_plus(make_enrollment):
    bundle = EnrollmentBundle.model_validate(
        make_enrollment(nationality="US", thresholds=(18,))
    )
    out = await verify_enrollment(bundle)
    assert out.disclosed_predicates == {"region": "NA", "age_band": "18+"}


async def test_full_senior_band(make_enrollment):
    bundle = EnrollmentBundle.model_validate(
        make_enrollment(nationality="JP", thresholds=(18, 25, 35, 50, 65))
    )
    out = await verify_enrollment(bundle)
    assert out.disclosed_predicates == {"region": "AS", "age_band": "65+"}


async def test_proof_invalid_rejected(make_enrollment):
    bundle = EnrollmentBundle.model_validate(make_enrollment(verified=False))
    with pytest.raises(VerifyEnrollmentError) as exc:
        await verify_enrollment(bundle)
    assert exc.value.reason is RejectionReason.SELF_PROOF_INVALID


async def test_registry_unconfirmed_rejected(make_enrollment):
    bundle = EnrollmentBundle.model_validate(
        make_enrollment(registry_confirmed=False)
    )
    with pytest.raises(VerifyEnrollmentError) as exc:
        await verify_enrollment(bundle)
    assert exc.value.reason is RejectionReason.SELF_REGISTRY_UNCONFIRMED


async def test_agent_binding_mismatch_rejected(make_enrollment):
    bundle = EnrollmentBundle.model_validate(
        make_enrollment(bound_agent_key="AAAA-different-userDefinedData")
    )
    with pytest.raises(VerifyEnrollmentError) as exc:
        await verify_enrollment(bundle)
    assert exc.value.reason is RejectionReason.SELF_AGENT_BINDING_MISMATCH


async def test_nullifier_mismatch_across_proofs_rejected(make_enrollment):
    bundle = EnrollmentBundle.model_validate(
        make_enrollment(
            thresholds=(18, 25),
            per_proof_nullifier=["self:a", "self:b"],
        )
    )
    with pytest.raises(VerifyEnrollmentError) as exc:
        await verify_enrollment(bundle)
    assert exc.value.reason is RejectionReason.SELF_NULLIFIER_MISMATCH


async def test_unmapped_country_rejected(make_enrollment):
    bundle = EnrollmentBundle.model_validate(
        make_enrollment(nationality="ZZ", thresholds=(18,))
    )
    with pytest.raises(VerifyEnrollmentError) as exc:
        await verify_enrollment(bundle)
    assert exc.value.reason is RejectionReason.PREDICATE_DERIVATION_FAILED


async def test_invalid_agent_key_rejected(make_enrollment):
    bundle = EnrollmentBundle.model_validate(
        make_enrollment(agent_key="not-base64-!!!")
    )
    with pytest.raises(VerifyEnrollmentError) as exc:
        await verify_enrollment(bundle)
    assert exc.value.reason is RejectionReason.ENROLLMENT_MALFORMED
