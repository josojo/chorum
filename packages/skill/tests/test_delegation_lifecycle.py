"""Delegation lifecycle tests (§7.5, §12).

* fresh load
* expiry behavior
* deterministic delegation hash
* refresh trigger (no auto phone call)
"""

from __future__ import annotations

from datetime import timedelta

import pytest

from hearme_skill.delegation import (
    DelegationExpired,
    DelegationMissing,
    REFRESH_WINDOW,
    assert_usable,
    hash_of,
    load_delegation,
    load_usable,
    needs_refresh_soon,
    store_delegation,
)


def test_store_then_load_roundtrip(tmp_root, fresh_token):
    path = tmp_root / "delegation.token"
    store_delegation(path, fresh_token)
    loaded = load_delegation(path)
    assert loaded.model_dump(mode="json") == fresh_token.model_dump(mode="json")


def test_load_missing_raises(tmp_root):
    with pytest.raises(DelegationMissing):
        load_delegation(tmp_root / "nope.token")


def test_assert_usable_fresh(fresh_token, now):
    assert_usable(fresh_token, now=now)  # does not raise


def test_assert_usable_expired_raises(expired_token, now):
    with pytest.raises(DelegationExpired):
        assert_usable(expired_token, now=now)


def test_load_usable_raises_on_expiry(tmp_root, expired_token, now):
    path = tmp_root / "delegation.token"
    store_delegation(path, expired_token)
    with pytest.raises(DelegationExpired):
        load_usable(path, now=now)


def test_refresh_window_detection(fresh_token, now):
    # Within window: token expiring tomorrow.
    nearly_expired = fresh_token.model_copy(
        update={"expires_at": now + timedelta(days=3)}
    )
    assert needs_refresh_soon(nearly_expired, now=now) is True

    far = fresh_token.model_copy(update={"expires_at": now + timedelta(days=89)})
    assert needs_refresh_soon(far, now=now) is False

    edge = fresh_token.model_copy(update={"expires_at": now + REFRESH_WINDOW})
    assert needs_refresh_soon(edge, now=now) is True


def test_delegation_hash_is_deterministic(fresh_token):
    h1 = hash_of(fresh_token)
    h2 = hash_of(fresh_token)
    assert h1 == h2
    assert len(h1) == 32


def test_loading_expired_does_not_contact_phone(tmp_root, expired_token, now, phone_bridge):
    """§1.13: expiry triggers UI nudge, never a phone call from the skill."""

    path = tmp_root / "delegation.token"
    store_delegation(path, expired_token)
    with pytest.raises(DelegationExpired):
        load_usable(path, now=now)
    assert phone_bridge.call_count == 0
