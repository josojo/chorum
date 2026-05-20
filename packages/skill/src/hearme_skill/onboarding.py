"""Onboarding — § 8.

The one moment the phone produces cryptographic material for the agent.

Flow (real, scan-ready):
  1. Skill generates an Ed25519 keypair (`agent_key`).
  2. Skill asks the zkpassport-bridge to create a request bound to that
     agent_key (`begin_onboarding`) and renders the returned `url` as a QR.
  3. User scans the QR with the ZKPassport app (a real passport, or a mock
     passport in devMode) and approves the disclosure.
  4. The proof is relayed back to the bridge; the skill polls
     (`complete_onboarding`), builds a `DelegationToken` wrapping the verifiable
     bundle, runs cheap structural checks, and stores it at
     ``~/.hermes/hearme/delegation.token``.

For development without a phone, ``accept_delegation_from_mock_phone()`` accepts
a DelegationToken JSON produced by ``scripts/mock-onboard.py`` (wrapping a
committed dev-mode fixture) and stores it the same way as the real flow.
"""

from __future__ import annotations

import base64
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx

from .crypto.canonical import canonical_json_bytes
from .crypto.keystore import load_or_create_agent_keypair
from .delegation import store_delegation
from .models import DelegationToken
from .zk_passport import IdentityBundleError, verify_bindings

# The disclosure profile names understood by the bridge (packages/zkpassport-bridge
# is the source of truth for the actual constraints + predicate mapping). v0
# ships one privacy-preserving profile.
DEFAULT_PROFILE = "eu-adult"
DISCLOSURE_PROFILES = {
    "eu-adult": "Proves age >= 18 and EU membership (no exact age or country).",
}


class OnboardingError(Exception):
    """Raised when the bridge onboarding flow fails or times out."""


@dataclass(frozen=True)
class OnboardingRequest:
    """The handle returned after a zkPassport request is created."""

    request_id: str
    url: str
    agent_public_key: str  # base64


def begin_onboarding(
    *,
    agent_key_path: Path,
    bridge_url: str,
    profile: str = DEFAULT_PROFILE,
    timeout: float = 30.0,
) -> OnboardingRequest:
    """Generate the agent key (if needed) and create a zkPassport request.

    Idempotent on the key: re-running reuses the existing agent key.
    """
    kp = load_or_create_agent_keypair(agent_key_path)
    agent_b64 = base64.b64encode(kp.public_bytes).decode("ascii")
    resp = httpx.post(
        f"{bridge_url.rstrip('/')}/requests",
        json={"agentKey": agent_b64, "profile": profile},
        timeout=timeout,
    )
    resp.raise_for_status()
    data = resp.json()
    return OnboardingRequest(
        request_id=data["requestId"],
        url=data["url"],
        agent_public_key=agent_b64,
    )


def render_qr_ascii(payload: str) -> str:
    """Render a payload (the zkPassport request `url`) as an ASCII QR.

    Uses the optional `qrcode` extra when present; otherwise prints the raw
    payload so the flow still works headless.
    """
    try:
        import io

        import qrcode  # type: ignore

        qr = qrcode.QRCode(border=1)
        qr.add_data(payload)
        qr.make(fit=True)
        buf = io.StringIO()
        qr.print_ascii(out=buf)
        return buf.getvalue()
    except ModuleNotFoundError:
        return f"[install `qrcode` for real QR rendering; open this link instead]\n{payload}\n"


def _iso_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def build_delegation_token(
    *,
    agent_public_key: str,
    unique_identifier: str,
    disclosed: dict[str, str],
    bundle: dict[str, Any],
    ttl_days: int = 90,
    now: datetime | None = None,
) -> DelegationToken:
    """Assemble a DelegationToken wrapping a verified zkPassport bundle."""
    moment = now or datetime.now(timezone.utc)
    expires = moment + timedelta(days=ttl_days)
    return DelegationToken.model_validate(
        {
            "version": 1,
            "zkpassport_proof": base64.b64encode(
                canonical_json_bytes(bundle)
            ).decode("ascii"),
            "domain": "hearme.network",
            "scope": "v1",
            "unique_identifier": unique_identifier,
            "disclosed_predicates": disclosed,
            "agent_key": agent_public_key,
            "issued_at": _iso_z(moment),
            "expires_at": _iso_z(expires),
        }
    )


def complete_onboarding(
    *,
    bridge_url: str,
    request_id: str,
    agent_public_key: str,
    delegation_path: Path,
    ttl_days: int = 90,
    poll_interval: float = 2.0,
    timeout_seconds: float = 300.0,
    http_timeout: float = 30.0,
) -> DelegationToken:
    """Poll the bridge until the proof arrives, build + store the token."""
    deadline = time.monotonic() + timeout_seconds
    url = f"{bridge_url.rstrip('/')}/requests/{request_id}"
    while True:
        resp = httpx.get(url, timeout=http_timeout)
        resp.raise_for_status()
        data = resp.json()
        status = data.get("status")
        if status == "complete":
            if not data.get("verified"):
                raise OnboardingError("bridge reported the proof did not verify")
            token = build_delegation_token(
                agent_public_key=agent_public_key,
                unique_identifier=data["uniqueIdentifier"],
                disclosed=data.get("disclosed") or {},
                bundle=data["bundle"],
                ttl_days=ttl_days,
            )
            # Cheap local sanity check; the broker re-verifies the SNARK.
            verify_bindings(token)
            store_delegation(delegation_path, token)
            return token
        if status in ("rejected", "error"):
            raise OnboardingError(f"onboarding {status}: {data.get('error')}")
        if time.monotonic() > deadline:
            raise OnboardingError(
                "timed out waiting for the phone to send a proof"
            )
        time.sleep(poll_interval)


def accept_delegation_from_mock_phone(
    *,
    raw_json: str,
    delegation_path: Path,
) -> DelegationToken:
    """Accept a DelegationToken JSON from ``scripts/mock-onboard.py`` (dev only).

    The real flow accepts the same JSON shape from the bridge — see
    :func:`accept_identity_bundle`.
    """
    return accept_identity_bundle(raw_json=raw_json, delegation_path=delegation_path)


def accept_identity_bundle(
    *,
    raw_json: str,
    delegation_path: Path,
) -> DelegationToken:
    """Receive a DelegationToken, run structural binding checks, and persist it.

    Raises:
        IdentityBundleError: if the embedded zkPassport bundle doesn't
            structurally bind to the token's agent_key / scope. (Full SNARK
            verification is the broker's job; the skill only catches obvious
            mismatches early.)
    """
    token = DelegationToken.model_validate_json(raw_json)
    verify_bindings(token)
    store_delegation(delegation_path, token)
    return token


__all__ = [
    "DEFAULT_PROFILE",
    "DISCLOSURE_PROFILES",
    "OnboardingError",
    "OnboardingRequest",
    "accept_delegation_from_mock_phone",
    "accept_identity_bundle",
    "begin_onboarding",
    "build_delegation_token",
    "complete_onboarding",
    "render_qr_ascii",
    "IdentityBundleError",
]
