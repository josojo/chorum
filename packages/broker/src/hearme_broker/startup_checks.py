"""Refuse to start in production with development defaults.

The broker's ``config.py`` ships dev defaults so a fresh ``dev-up.sh`` can
``uvicorn`` straight out of the box. Those defaults — the dev signing key, the
dev Postgres password, the dev-bypass registration route — are catastrophic if
they reach production: a forged DelegationToken signed by the dev key is
indistinguishable from a real one, and ``/v1/dev/register`` mints synthetic
identities with NO Self proof at all (ARCHITECTURE.md §5).

By default the app factory calls ``validate_production_config`` (this module)
BEFORE the FastAPI app is built. A misconfiguration raises
``ProductionConfigError`` and the process exits non-zero — failing closed is the
only safe default, "log a warning and continue" would let an operator paper over
an audit-relevant problem with a flag. The check is skipped ONLY when an operator
explicitly opts out with ``HEARME_BROKER_DEV_MODE=1`` (dev/test environments);
forgetting that flag therefore fails closed rather than booting with the dev key.

The check is **structural only**: it does not contact the DB, the bridge, or
the chain. Connectivity belongs in ``/healthz`` (which the orchestrator polls
anyway); this is the one-shot pre-flight that protects against the human-
error class of incidents.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

from .config import _DEV_BROKER_SIGNING_KEY, Settings

log = logging.getLogger("hearme_broker.startup_checks")


class ProductionConfigError(RuntimeError):
    """Raised when a dev default is detected and dev_mode was not opted into."""


@dataclass
class ValidationReport:
    """Findings from one validation run.

    ``errors`` block startup; ``warnings`` only log. The split matters: an
    error is "we know this is unsafe" (dev key in prod), a warning is "this
    is suspicious but might be deliberate" (localhost bridge in prod).
    """

    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def ok(self) -> bool:
        return not self.errors


def validate_production_config(settings: Settings) -> ValidationReport:
    """Apply every production-mode rule. Pure; safe to call from tests."""
    report = ValidationReport()

    if settings.signing_key == _DEV_BROKER_SIGNING_KEY:
        report.errors.append(
            "HEARME_BROKER_SIGNING_KEY is the documented dev default. Anyone "
            "with the source can forge a DelegationToken — generate a fresh "
            "Ed25519 seed and store it in your secret manager."
        )

    if "hearme_broker_dev" in settings.database_url:
        report.errors.append(
            "HEARME_BROKER_DATABASE_URL still uses the dev password "
            "('hearme_broker_dev'). Rotate the password and update the DSN."
        )

    if settings.dev_insecure_register:
        report.errors.append(
            "HEARME_BROKER_DEV_INSECURE_REGISTER=1 mounts POST /v1/dev/register "
            "which mints DelegationTokens for synthetic identities with NO "
            "Self proof. Set it to 0 in production."
        )

    if not settings.require_registry_confirmation:
        report.errors.append(
            "HEARME_BROKER_REQUIRE_REGISTRY_CONFIRMATION=0 skips the one-time "
            "on-chain Celo registry/root check. That is the only anchor "
            "between Self's off-chain SNARK and one-passport→one-identity "
            "(ARCHITECTURE.md §5). Re-enable it."
        )

    if settings.expose_rejection_reasons:
        report.errors.append(
            "HEARME_BROKER_EXPOSE_REJECTION_REASONS=1 makes the broker a "
            "verification oracle (an attacker learns *which* field of a "
            "forged envelope was wrong). Set it False in production."
        )

    # --- warnings: suspicious but not strictly blocking -----------------
    if "localhost" in settings.self_bridge_url or "127.0.0.1" in settings.self_bridge_url:
        # OK if the bridge runs as a sidecar in the same Pod / on the same host,
        # which is the recommended deployment shape. Still worth flagging.
        report.warnings.append(
            f"HEARME_BROKER_SELF_BRIDGE_URL={settings.self_bridge_url!r} points at "
            "localhost. OK if the bridge is a same-host sidecar; otherwise update."
        )

    return report


def enforce_production_config(settings: Settings) -> None:
    """Run the validator and raise ``ProductionConfigError`` on any error.

    Called from ``main.create_app`` unless ``settings.dev_mode`` is True.
    Warnings are logged either way; errors abort the process via exception.
    """
    report = validate_production_config(settings)
    for w in report.warnings:
        log.warning("startup-check: %s", w)
    if not report.ok():
        joined = "\n  - " + "\n  - ".join(report.errors)
        raise ProductionConfigError(
            "Refusing to start with dev defaults (set HEARME_BROKER_DEV_MODE=1 "
            "only in dev/test):" + joined
        )
    log.info("startup-check: production config OK")
