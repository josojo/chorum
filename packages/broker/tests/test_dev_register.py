"""The dev-only insecure register route must be gated by the env flag.

It bypasses Self proof-of-personhood entirely, so it must NOT exist unless
``HEARME_BROKER_DEV_INSECURE_REGISTER`` is explicitly truthy. Route mounting is
decided in ``create_app`` from settings, so we can assert it without a DB.
"""

from __future__ import annotations

from hearme_broker.main import create_app


def _paths(app) -> set[str | None]:
    return {getattr(r, "path", None) for r in app.routes}


def test_dev_register_absent_by_default(monkeypatch):
    monkeypatch.delenv("HEARME_BROKER_DEV_INSECURE_REGISTER", raising=False)
    assert "/v1/dev/register" not in _paths(create_app())


def test_dev_register_mounted_when_flagged(monkeypatch):
    monkeypatch.setenv("HEARME_BROKER_DEV_INSECURE_REGISTER", "1")
    assert "/v1/dev/register" in _paths(create_app())
