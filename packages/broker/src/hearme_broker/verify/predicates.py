"""Pure predicate derivation: Self disclosures -> Hearme bucketed predicates.

The broker is authoritative for ``disclosed_predicates`` (ARCHITECTURE.md §5):
it derives them from the verified Self outputs, never trusting a client copy.

- ``region``  <- disclosed nationality (ISO-3166 alpha-2) mapped to a continent
  code (AF/AN/AS/EU/NA/OC/SA), matching the questions table + eligibility.py.
  Europe collapses to ``EU`` (the continent code the seed data / scope checks
  use). The raw country is NOT persisted.
- ``age_band`` <- the set of satisfied "older-than" thresholds from the
  multi-threshold ladder (§8.3). Self can only PRODUCE a proof for a threshold
  the holder satisfies, so the max satisfied threshold fixes the band. A single
  ``18`` proof (minimal profile / graceful degradation) yields ``18+``.
"""

from __future__ import annotations


class PredicateError(ValueError):
    """Raised when disclosures can't be mapped to valid Hearme predicates."""


# Continent membership by ISO-3166-1 alpha-2. Europe -> "EU" (continent code,
# per questions_continent_chk: AF, AN, AS, EU, NA, OC, SA).
_CONTINENT_COUNTRIES: dict[str, set[str]] = {
    "EU": {
        "AL", "AD", "AT", "BA", "BE", "BG", "BY", "CH", "CY", "CZ", "DE", "DK",
        "EE", "ES", "FI", "FO", "FR", "GB", "GE", "GI", "GR", "HR", "HU", "IE",
        "IS", "IT", "LI", "LT", "LU", "LV", "MC", "MD", "ME", "MK", "MT", "NL",
        "NO", "PL", "PT", "RO", "RS", "RU", "SE", "SI", "SK", "SM", "UA", "VA",
        "XK",
    },
    "AS": {
        "AE", "AF", "AM", "AZ", "BD", "BH", "BN", "BT", "CN", "HK", "ID", "IL",
        "IN", "IQ", "IR", "JO", "JP", "KG", "KH", "KP", "KR", "KW", "KZ", "LA",
        "LB", "LK", "MM", "MN", "MO", "MV", "MY", "NP", "OM", "PH", "PK", "PS",
        "QA", "SA", "SG", "SY", "TH", "TJ", "TL", "TM", "TR", "TW", "UZ", "VN",
        "YE",
    },
    "AF": {
        "AO", "BF", "BI", "BJ", "BW", "CD", "CF", "CG", "CI", "CM", "CV", "DJ",
        "DZ", "EG", "EH", "ER", "ET", "GA", "GH", "GM", "GN", "GQ", "GW", "KE",
        "KM", "LR", "LS", "LY", "MA", "MG", "ML", "MR", "MU", "MW", "MZ", "NA",
        "NE", "NG", "RW", "SC", "SD", "SL", "SN", "SO", "SS", "ST", "SZ", "TD",
        "TG", "TN", "TZ", "UG", "ZA", "ZM", "ZW",
    },
    "NA": {
        "AG", "BB", "BS", "BZ", "CA", "CR", "CU", "DM", "DO", "GD", "GT", "HN",
        "HT", "JM", "KN", "LC", "MX", "NI", "PA", "PR", "SV", "TT", "US", "VC",
    },
    "SA": {
        "AR", "BO", "BR", "CL", "CO", "EC", "GY", "PE", "PY", "SR", "UY", "VE",
    },
    "OC": {
        "AU", "FJ", "FM", "KI", "MH", "NR", "NZ", "PG", "PW", "SB", "TO", "TV",
        "VU", "WS",
    },
    "AN": {"AQ"},
}

_COUNTRY_TO_CONTINENT: dict[str, str] = {
    country: continent
    for continent, countries in _CONTINENT_COUNTRIES.items()
    for country in countries
}

# The standard age ladder (ARCHITECTURE.md §8.3). Keep in sync with the
# self-bridge SELF_AGE_THRESHOLDS default.
AGE_LADDER: tuple[int, ...] = (18, 25, 35, 50, 65)

_BAND_BY_MAX: dict[int, str] = {
    18: "18-24",
    25: "25-34",
    35: "35-49",
    50: "50-64",
    65: "65+",
}


def country_to_region(country: str) -> str:
    """Map an ISO-3166 alpha-2 country code to a continent code (region)."""
    if not country:
        raise PredicateError("nationality missing")
    code = country.strip().upper()
    region = _COUNTRY_TO_CONTINENT.get(code)
    if region is None:
        raise PredicateError(f"unmapped country code {code!r}")
    return region


def thresholds_to_age_band(satisfied: list[int]) -> str:
    """Map satisfied older-than thresholds to a 5-year-ish band.

    ``satisfied`` is the set of ladder thresholds the holder PROVED (one proof
    per threshold). 18 must be present (registration is adult-gated). A lone
    ``18`` (minimal profile / user skipped the finer scans) yields ``18+``;
    otherwise the band is fixed by the maximum satisfied threshold.
    """
    valid = sorted({t for t in satisfied if t in AGE_LADDER})
    if not valid or valid[0] != 18:
        raise PredicateError("age: no satisfied 18+ threshold")
    if len(valid) == 1:
        return "18+"
    return _BAND_BY_MAX[valid[-1]]


def derive_predicates(*, nationality: str, satisfied_thresholds: list[int]) -> dict[str, str]:
    """Full derivation -> ``{region, age_band}``. Raises ``PredicateError``."""
    return {
        "region": country_to_region(nationality),
        "age_band": thresholds_to_age_band(satisfied_thresholds),
    }
