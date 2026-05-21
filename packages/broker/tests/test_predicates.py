"""Pure predicate derivation — country->region, thresholds->age_band."""

from __future__ import annotations

import pytest

from hearme_broker.verify.predicates import (
    PredicateError,
    country_to_region,
    derive_predicates,
    thresholds_to_age_band,
)


@pytest.mark.parametrize(
    "country,region",
    [
        ("DE", "EU"), ("de", "EU"), ("FR", "EU"), ("GB", "EU"), ("RU", "EU"),
        ("US", "NA"), ("MX", "NA"), ("BR", "SA"), ("AR", "SA"),
        ("JP", "AS"), ("CN", "AS"), ("IN", "AS"),
        ("NG", "AF"), ("ZA", "AF"), ("AU", "OC"), ("NZ", "OC"),
    ],
)
def test_country_to_region(country, region):
    assert country_to_region(country) == region


def test_country_to_region_unmapped_raises():
    with pytest.raises(PredicateError):
        country_to_region("ZZ")
    with pytest.raises(PredicateError):
        country_to_region("")


@pytest.mark.parametrize(
    "satisfied,band",
    [
        ([18], "18+"),
        ([18, 25], "25-34"),
        ([18, 25, 35], "35-49"),
        ([18, 25, 35, 50], "50-64"),
        ([18, 25, 35, 50, 65], "65+"),
        ([35, 25, 18], "35-49"),  # order-independent
    ],
)
def test_thresholds_to_age_band(satisfied, band):
    assert thresholds_to_age_band(satisfied) == band


def test_thresholds_without_18_rejected():
    with pytest.raises(PredicateError):
        thresholds_to_age_band([25, 35])
    with pytest.raises(PredicateError):
        thresholds_to_age_band([])


def test_unknown_thresholds_ignored():
    # 40 isn't on the ladder; ignored, band still from the valid max (35).
    assert thresholds_to_age_band([18, 25, 35, 40]) == "35-49"


def test_derive_predicates():
    assert derive_predicates(nationality="FR", satisfied_thresholds=[18, 25]) == {
        "region": "EU",
        "age_band": "25-34",
    }
