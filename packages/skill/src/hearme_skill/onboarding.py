"""Onboarding — § 8 (verify-once with Self).

The one moment the phone produces cryptographic material for the agent.

Flow (real, scan-ready):
  1. Skill generates an Ed25519 keypair (`agent_key`).
  2. Skill asks the self-bridge to create one Self request per age threshold,
     each bound to `agent_key` (`begin_onboarding`), and renders each returned
     `url` as a QR.
  3. User scans with the Self app (a real passport, or a mock passport in
     staging) and approves; the Self app POSTs each proof to the bridge.
  4. The skill polls the bridge for the verified proofs (`complete_onboarding`),
     bundles them into an EnrollmentBundle, POSTs it to the broker's
     `POST /v1/register`, and stores the broker-issued `DelegationToken` at
     ``~/.hermes/hearme/delegation.token``.

For development without a phone, ``accept_delegation_from_mock_phone()`` accepts
a broker-issued DelegationToken JSON (e.g. produced by ``scripts/mock-onboard.py``,
which drives the same `/v1/register` call) and stores it like the real flow.
"""

from __future__ import annotations

import base64
import time
from dataclasses import dataclass
from pathlib import Path

import httpx

from .crypto.keystore import load_or_create_agent_keypair
from .delegation import store_delegation
from .models import DelegationToken
from .self_identity import IdentityBundleError, validate_token

# Disclosure profiles understood by the self-bridge (the bridge is the source of
# truth for the thresholds + disclosures). ``standard`` runs the full age ladder.
DEFAULT_PROFILE = "standard"
DISCLOSURE_PROFILES = {
    "standard": "Nationality + the older-than ladder [18,25,35,50,65] (no DOB).",
    "minimal": "Nationality + a single 18+ proof (no generational band).",
}


class OnboardingError(Exception):
    """Raised when the bridge/broker onboarding flow fails or times out."""


@dataclass(frozen=True)
class OnboardingRequest:
    """The handle returned after Self requests are created."""

    request_id: str
    urls: list[str]
    agent_public_key: str  # base64


def begin_onboarding(
    *,
    agent_key_path: Path,
    bridge_url: str,
    profile: str = DEFAULT_PROFILE,
    timeout: float = 30.0,
) -> OnboardingRequest:
    """Generate the agent key (if needed) and create the Self request(s).

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
        urls=data.get("urls") or [],
        agent_public_key=agent_b64,
    )


def render_qr_ascii(payload: str) -> str:
    """Render a payload (a Self request `url`) as an ASCII QR.

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


def _register_with_broker(
    *,
    broker_url: str,
    self_proofs: list[dict],
    agent_public_key: str,
    http_timeout: float,
) -> DelegationToken:
    """POST the EnrollmentBundle to the broker and return the issued token."""
    resp = httpx.post(
        f"{broker_url.rstrip('/')}/v1/register",
        json={"self_proofs": self_proofs, "agent_key": agent_public_key},
        timeout=http_timeout,
    )
    resp.raise_for_status()
    ack = resp.json()
    if not ack.get("accepted"):
        raise OnboardingError(f"broker rejected registration: {ack.get('reason')}")
    token_data = ack.get("delegation_token")
    if not token_data:
        raise OnboardingError("broker accepted but returned no delegation_token")
    token = DelegationToken.model_validate(token_data)
    validate_token(token, expected_agent_key=agent_public_key)
    return token


def complete_onboarding(
    *,
    bridge_url: str,
    broker_url: str,
    request_id: str,
    agent_public_key: str,
    delegation_path: Path,
    poll_interval: float = 2.0,
    timeout_seconds: float = 300.0,
    http_timeout: float = 30.0,
) -> DelegationToken:
    """Poll the bridge for the proofs, register with the broker, store the token."""
    deadline = time.monotonic() + timeout_seconds
    url = f"{bridge_url.rstrip('/')}/requests/{request_id}"
    while True:
        resp = httpx.get(url, timeout=http_timeout)
        resp.raise_for_status()
        data = resp.json()
        status = data.get("status")
        if status == "complete":
            if not data.get("verified"):
                raise OnboardingError("bridge reported a proof did not verify")
            bundles = data.get("bundles") or []
            if not bundles:
                raise OnboardingError("bridge returned no proof bundles")
            token = _register_with_broker(
                broker_url=broker_url,
                self_proofs=bundles,
                agent_public_key=agent_public_key,
                http_timeout=http_timeout,
            )
            store_delegation(delegation_path, token)
            return token
        if status in ("rejected", "error"):
            raise OnboardingError(f"onboarding {status}: {data.get('error')}")
        if time.monotonic() > deadline:
            raise OnboardingError("timed out waiting for the phone to send proofs")
        time.sleep(poll_interval)


def accept_delegation_from_mock_phone(
    *,
    raw_json: str,
    delegation_path: Path,
) -> DelegationToken:
    """Accept a broker-issued DelegationToken JSON (dev). Same shape as the
    real flow's stored token — see :func:`accept_identity_bundle`."""
    return accept_identity_bundle(raw_json=raw_json, delegation_path=delegation_path)


def accept_identity_bundle(
    *,
    raw_json: str,
    delegation_path: Path,
) -> DelegationToken:
    """Receive a broker-issued DelegationToken, run cheap structural checks,
    and persist it.

    Raises:
        IdentityBundleError: if the token is structurally unusable. (Full
            validation — broker signature, registry, expiry — is the broker's
            job at answer time.)
    """
    token = DelegationToken.model_validate_json(raw_json)
    validate_token(token)
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
    "complete_onboarding",
    "render_qr_ascii",
    "IdentityBundleError",
]
