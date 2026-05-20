"""Well-known phone pubkey used to verify DelegationToken.phone_signature.

v0: hardcoded. In v0.2+ this is fetched from a trusted directory (or
the ZKPassport service's public registry) — see ARCHITECTURE.md §11
("Real zkPassport proof verification" stub).

Environment overrides:
    HEARME_PHONE_PUBKEY_BASE64  — base64 Ed25519 pubkey (32 bytes)

That env hook exists so tests can substitute a key produced by their own
signer. The function reads at call time so test fixtures monkeypatching
``os.environ`` see the change.
"""

from __future__ import annotations

import base64
import os

from nacl.signing import VerifyKey

# STUB: v0 trusts a single phone pubkey. In production, the broker should
# resolve the right phone key for the user via the DelegationToken's
# attestation chain rooted in ZKPassport. Not yet real.
#
# This default matches the deterministic dev keypair in scripts/mock-phone.py
# (Ed25519 seed = bytes([1] * 32)) so `docker compose up` works without
# additional configuration. Tests override via HEARME_PHONE_PUBKEY_BASE64.
_DEV_PHONE_PUBKEY_BASE64 = "iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w="


def phone_pubkey_base64() -> str:
    return os.environ.get("HEARME_PHONE_PUBKEY_BASE64", _DEV_PHONE_PUBKEY_BASE64)


def phone_verify_key() -> VerifyKey:
    raw = base64.b64decode(phone_pubkey_base64())
    if len(raw) != 32:
        raise ValueError(
            f"phone pubkey must be 32 bytes (got {len(raw)}); check HEARME_PHONE_PUBKEY_BASE64"
        )
    return VerifyKey(raw)


# ---------------------------------------------------------------------------
# zkPassport issuer registry.
#
# v0.2 stand-in: maps an ``issuer_key_id`` (string) to an Ed25519 pubkey.
# A real implementation would resolve issuer_key_id against the ICAO Public
# Key Directory (CSCA pubkeys) and verify a SNARK proof rather than an
# Ed25519 signature. The structural shape — "by id, give me the issuer's
# pubkey" — is the same, so swapping the verifier is mechanical.
#
# The default issuer pubkey matches the one ``scripts/mock-phone.py`` uses
# (deterministic Ed25519 seed = bytes([2] * 32), id "icao-csca-test-2026"),
# so ``docker compose up`` works without further configuration.
#
# Env override format (comma-separated ``id:base64`` pairs):
#   HEARME_ZK_ISSUERS="icao-csca-test-2026:gTl3D...=,eu-test:Xyz...="

_DEV_ZK_ISSUER_ID = "icao-csca-test-2026"
_DEV_ZK_ISSUER_PUBKEY_BASE64 = "gTl3Dqh9F19Wo1Rmw0x+zMuNipG07jeiXfYPW4/Js5Q="


def _parse_issuers_env(raw: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for entry in raw.split(","):
        entry = entry.strip()
        if not entry:
            continue
        if ":" not in entry:
            raise ValueError(
                f"HEARME_ZK_ISSUERS entry {entry!r} missing ':' separator"
            )
        kid, pub = entry.split(":", 1)
        out[kid.strip()] = pub.strip()
    return out


def zk_issuer_pubkey_base64(issuer_key_id: str) -> str | None:
    """Return the registered pubkey (base64) for ``issuer_key_id``, or None.

    Reads ``HEARME_ZK_ISSUERS`` at call time so tests monkey-patching the
    environment see the change immediately.
    """
    env = os.environ.get("HEARME_ZK_ISSUERS")
    if env:
        try:
            registry = _parse_issuers_env(env)
        except ValueError:
            registry = {}
        if issuer_key_id in registry:
            return registry[issuer_key_id]
    if issuer_key_id == _DEV_ZK_ISSUER_ID:
        return _DEV_ZK_ISSUER_PUBKEY_BASE64
    return None


def zk_issuer_verify_key(issuer_key_id: str) -> VerifyKey | None:
    pub = zk_issuer_pubkey_base64(issuer_key_id)
    if pub is None:
        return None
    raw = base64.b64decode(pub)
    if len(raw) != 32:
        raise ValueError(
            f"zk issuer pubkey for {issuer_key_id!r} must be 32 bytes (got {len(raw)})"
        )
    return VerifyKey(raw)
