"""Skill-side handling of the broker-issued DelegationToken.

Verify-once model (ARCHITECTURE.md §5/§8): the broker verifies the Self proofs
once at ``/v1/register`` and returns a broker-SIGNED ``DelegationToken``. The
skill treats that token as opaque — it cannot (and need not) re-verify the
broker signature; only the broker can. The skill does cheap *structural* checks
so obvious mistakes (wrong agent key, missing fields) are caught locally before
an envelope is built.
"""

from __future__ import annotations

from .models import DelegationToken


class IdentityBundleError(ValueError):
    """Raised when a stored/received DelegationToken is structurally unusable
    for this agent (e.g. bound to a different agent key)."""


def validate_token(
    token: DelegationToken, *, expected_agent_key: str | None = None
) -> None:
    """Cheap local sanity checks on a broker-issued token.

    - ``broker_signature`` is non-empty,
    - if ``expected_agent_key`` is given, the token is bound to it (this token
      really speaks for *our* agent key).

    Full validation (broker signature, registry, expiry) is the broker's job at
    answer time; this only catches local user/wiring errors early.
    """
    if not token.broker_signature:
        raise IdentityBundleError("token is missing broker_signature")
    if expected_agent_key is not None and token.agent_key != expected_agent_key:
        raise IdentityBundleError(
            "token.agent_key does not match this agent's key "
            "(token was issued for a different agent)"
        )
