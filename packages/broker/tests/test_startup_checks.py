"""Production-mode startup validation (``startup_checks.py``).

A misconfiguration here is silent and catastrophic — a dev signing key in
prod lets anyone forge a DelegationToken; a dev-bypass route mints
identities with no Self proof. So the check must *fail closed*: any
documented dev default detected in production mode aborts startup before
the FastAPI app is built.

These tests pin the exact list of rules: every dev default that ships in
``config.py`` MUST be caught here, and the clean-config case MUST pass.
If anyone adds a new dev default to ``config.py`` they have to add a
matching rule + test in this file.
"""

from __future__ import annotations

import pytest

from hearme_broker.config import _DEV_BROKER_SIGNING_KEY, Settings, get_settings
from hearme_broker.startup_checks import (
    ProductionConfigError,
    enforce_production_config,
    validate_production_config,
)


def _prod_clean() -> Settings:
    """Settings shaped like a properly-configured prod broker.

    Override every default the validator inspects with a non-dev value, so
    each subsequent test can flip exactly one back to a dev default and
    assert the validator catches it.
    """
    return Settings(  # type: ignore[call-arg]
        signing_key="aGVhcm1lLXByb2QtdGVzdC1zaWduaW5nLWtleS0zMmJ5dGVz",
        database_url="postgres://hearme_broker:STRONG-rotated-pw@db:5432/hearme",
        dev_insecure_register=False,
        require_registry_confirmation=True,
        expose_rejection_reasons=False,
        self_bridge_url="https://bridge.internal.hearme.example",
    )


def test_clean_prod_config_passes_and_does_not_raise():
    report = validate_production_config(_prod_clean())
    assert report.ok()
    assert report.errors == []
    # Cleanest possible — no warnings either.
    assert report.warnings == []
    enforce_production_config(_prod_clean())  # must not raise


def test_dev_signing_key_blocks_startup():
    settings = _prod_clean().model_copy(
        update={"signing_key": _DEV_BROKER_SIGNING_KEY}
    )
    with pytest.raises(ProductionConfigError, match="SIGNING_KEY"):
        enforce_production_config(settings)


def test_dev_db_password_blocks_startup():
    settings = _prod_clean().model_copy(
        update={
            "database_url": "postgres://hearme_broker:hearme_broker_dev@db:5432/hearme"
        }
    )
    with pytest.raises(ProductionConfigError, match="DATABASE_URL"):
        enforce_production_config(settings)


def test_dev_insecure_register_blocks_startup():
    settings = _prod_clean().model_copy(update={"dev_insecure_register": True})
    with pytest.raises(ProductionConfigError, match="DEV_INSECURE_REGISTER"):
        enforce_production_config(settings)


def test_registry_confirmation_off_blocks_startup():
    settings = _prod_clean().model_copy(
        update={"require_registry_confirmation": False}
    )
    with pytest.raises(ProductionConfigError, match="REGISTRY_CONFIRMATION"):
        enforce_production_config(settings)


def test_oracle_mode_blocks_startup():
    settings = _prod_clean().model_copy(update={"expose_rejection_reasons": True})
    with pytest.raises(ProductionConfigError, match="EXPOSE_REJECTION_REASONS"):
        enforce_production_config(settings)


def test_localhost_bridge_is_warning_not_error():
    """The bridge often runs as a same-host sidecar in v0; flag it but don't
    refuse to start (the operator may have deliberately chosen that shape)."""
    settings = _prod_clean().model_copy(
        update={"self_bridge_url": "http://localhost:8787"}
    )
    report = validate_production_config(settings)
    assert report.ok()
    assert any("localhost" in w.lower() for w in report.warnings)


def test_signing_key_is_read_from_HEARME_BROKER_SIGNING_KEY_env(monkeypatch):
    """Regression: the signing key MUST load from the env var the deployment
    actually sets — ``HEARME_BROKER_SIGNING_KEY``.

    The original bug named the field ``broker_signing_key``; combined with
    ``env_prefix="HEARME_BROKER_"`` pydantic looked for
    ``HEARME_BROKER_BROKER_SIGNING_KEY`` (double "BROKER"), which no compose
    file sets — so the dev default silently won and prod refused to boot even
    with a real key configured. Every other test sets the field via a
    constructor kwarg, which bypasses env resolution and hid this. This test
    pins the wire name.
    """
    real_key = "aGVhcm1lLXByb2QtdGVzdC1zaWduaW5nLWtleS0zMmJ5dGVz"
    assert real_key != _DEV_BROKER_SIGNING_KEY
    # The double-BROKER name (the buggy one) must be ignored.
    monkeypatch.setenv("HEARME_BROKER_BROKER_SIGNING_KEY", _DEV_BROKER_SIGNING_KEY)
    monkeypatch.setenv("HEARME_BROKER_SIGNING_KEY", real_key)

    settings = get_settings()

    assert settings.signing_key == real_key


def test_all_dev_defaults_collapse_into_one_combined_error():
    """When several rules trip at once, the error message lists them all —
    so a fresh operator sees the entire missing-config list in one boot
    attempt instead of fixing one, re-deploying, hitting the next, etc."""
    # Default Settings() — i.e. every dev default still in place.
    report = validate_production_config(Settings())  # type: ignore[call-arg]
    # The five hard rules (signing key, DB password, dev register,
    # registry confirmation, expose reasons) — `require_registry_confirmation`
    # defaults to True so it won't trip; everything else WILL.
    assert len(report.errors) >= 3
    with pytest.raises(ProductionConfigError) as exc:
        enforce_production_config(Settings())  # type: ignore[call-arg]
    # All caught errors appear in the single raised message.
    for err in report.errors:
        # Match on the env-var token in each error, which is the durable bit.
        token = err.split(" ", 1)[0]
        assert token in str(exc.value)
