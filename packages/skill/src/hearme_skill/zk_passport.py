"""ZK passport identity bundle handling (skill side).

The zkpassport-bridge produces the cryptographic material; the skill's job is
to receive a ``DelegationToken`` (carrying the verifiable zkPassport bundle in
``zkpassport_proof``), run the cheap structural checks it can do without the
heavy UltraHonk verifier, and store the token on disk for the envelope layer.

The skill DELIBERATELY does NOT run the SNARK verification here:

* SNARK verification needs the Node bridge + @aztec/bb.js; the skill stays light.
* The broker is the source of truth and re-verifies every proof, surfacing a
  clear rejection reason.
* Keeping the skill's surface narrow matches §1.13 (phone is enrollment-only).

The skill DOES check (fast, catches wrong-bundle / user-error early):

* ``zkpassport_proof`` base64-decodes and parses as the expected bundle shape.
* The bundle's ``query.bind.custom_data`` equals ``token.agent_key`` (the proof
  is bound to *our* agent key).
* The bundle ``scope`` matches the token scope.
"""

from __future__ import annotations

import base64
import binascii
import json
from typing import Any

from .models import DelegationToken


class IdentityBundleError(ValueError):
    """Raised when an incoming identity bundle doesn't structurally bind to
    the agent_key / scope already in the delegation token."""


def parse_bundle_from_token(token: DelegationToken) -> dict[str, Any]:
    """Decode ``token.zkpassport_proof`` (base64 of canonical JSON) and parse."""
    try:
        raw = base64.b64decode(token.zkpassport_proof, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise IdentityBundleError(
            f"zkpassport_proof base64 decode failed: {exc}"
        ) from exc
    try:
        bundle = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise IdentityBundleError(f"zkpassport_proof parse failed: {exc}") from exc
    if not isinstance(bundle, dict):
        raise IdentityBundleError("zkpassport_proof is not a JSON object")
    for key in ("proofs", "query", "queryResult", "scope"):
        if key not in bundle:
            raise IdentityBundleError(f"zkpassport_proof bundle missing {key!r}")
    return bundle


def verify_bindings(token: DelegationToken) -> dict[str, Any]:
    """Structural binding checks. Returns the parsed bundle on success.

    Does NOT verify the SNARK — that's the broker's job (cf. module docstring).
    """
    bundle = parse_bundle_from_token(token)

    bound = ((bundle.get("query") or {}).get("bind") or {}).get("custom_data")
    if bound != token.agent_key:
        raise IdentityBundleError(
            "bundle query.bind.custom_data does not equal token.agent_key"
        )

    if bundle.get("scope") != token.scope:
        raise IdentityBundleError(
            f"bundle scope={bundle.get('scope')!r} does not match token scope "
            f"{token.scope!r}"
        )
    return bundle
