"""Broker runtime configuration.

Environment-driven. The DATABASE_URL points at the shared Postgres using the
``hearme_broker`` role (see /db/init/02-roles.sh and the README).
"""

from __future__ import annotations

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# Dev-only Ed25519 seed for the broker signing key (base64 of 32 bytes).
# Production MUST override HEARME_BROKER_SIGNING_KEY with a secret-managed key;
# a stable key is required so DelegationTokens survive broker restarts.
_DEV_BROKER_SIGNING_KEY = "QlJPS0VSLVNJR05JTkctS0VZLUhFQVJNRS1ERVYzMkI="  # b"BROKER-SIGNING-KEY-HEARME-DEV32B"


class Settings(BaseSettings):
    """Broker settings.

    Defaults match the docker-compose dev environment so a fresh `dev-up.sh`
    can `uvicorn` straight out of the box.
    """

    model_config = SettingsConfigDict(env_prefix="HEARME_BROKER_", extra="ignore")

    database_url: str = Field(
        default="postgres://hearme_broker:hearme_broker_dev@localhost:5432/hearme",
        description="asyncpg-compatible DSN scoped to the hearme_broker role.",
    )
    db_pool_min_size: int = 1
    db_pool_max_size: int = 10
    # v0 returns detailed rejection reasons to help integration. Production
    # should set this False (avoid being an oracle — see ARCHITECTURE.md §5).
    expose_rejection_reasons: bool = True

    # self-bridge: the Node sidecar that runs @selfxyz/core's SelfBackendVerifier
    # (off-chain SNARK) plus the one-time on-chain Celo registry/root check. The
    # broker calls it ONLY at POST /v1/register (verify-once); never per envelope.
    # Point this at a bridge instance the broker controls.
    self_bridge_url: str = Field(
        default="http://localhost:8787",
        description="Base URL of the self-bridge POST /verify endpoint.",
    )
    self_verify_timeout_seconds: float = 30.0

    # Sybil hardening (ARCHITECTURE.md §5): require the bridge's one-time on-chain
    # registry/Merkle-root confirmation at registration. Default True (prod).
    # Dev/staging without a wired Celo RPC may set this False (documented risk).
    require_registry_confirmation: bool = True

    # Self on-chain invalidation listener. Disabled until production supplies the
    # concrete Self registry contract + revocation/update event ABI. When enabled,
    # the broker polls eth_getLogs and invalidates matching registrations/votes.
    self_revocation_listener_enabled: bool = False
    self_revocation_rpc_url: str = ""
    self_revocation_chain_id: str = "celo"
    self_revocation_contract_address: str = ""
    self_revocation_event_topic: str = ""
    # Usually the invalidated action/nullifier is an indexed event arg in
    # topics[1]. Set this to -1 and data_word_index >= 0 if it is emitted in data.
    self_revocation_nullifier_topic_index: int = 1
    self_revocation_nullifier_data_word_index: int = -1
    self_revocation_from_block: int = 0
    self_revocation_confirmations: int = 12
    self_revocation_poll_interval_seconds: float = 15.0
    self_revocation_cursor_name: str = "self-revocations-v1"

    # Ed25519 signing key (base64 of a 32-byte seed) the broker uses to sign the
    # DelegationToken it issues at registration. The agent treats the token as
    # opaque; only the broker validates it. MUST be overridden in production.
    # NOTE: the env var is HEARME_BROKER_SIGNING_KEY (env_prefix + this field
    # name). The field MUST stay `signing_key`, not `broker_signing_key` — the
    # latter would make pydantic look for HEARME_BROKER_BROKER_SIGNING_KEY,
    # which no deployment sets, so the dev default below would silently win.
    signing_key: str = Field(
        default=_DEV_BROKER_SIGNING_KEY,
        description="base64 of the 32-byte Ed25519 seed for the broker signing key.",
    )

    # DANGER — testing only. When True, the broker mounts POST /v1/dev/register,
    # which mints a DelegationToken for a SYNTHETIC identity WITHOUT any Self
    # proof or bridge verification. This defeats proof-of-personhood / Sybil
    # resistance entirely; it exists solely to exercise the answer→aggregate
    # pipeline end-to-end without a phone. MUST stay False in production.
    dev_insecure_register: bool = False

    # Fail-closed by default. create_app() runs
    # startup_checks.enforce_production_config() BEFORE the FastAPI app is built
    # and refuses to boot if any documented dev default is still set (dev signing
    # key, dev DB password, dev-bypass route, oracle-mode rejection reasons,
    # registry confirmation off). The ONLY way to relax that is to explicitly opt
    # out with HEARME_BROKER_DEV_MODE=1 — so forgetting a flag fails *closed*
    # (the broker refuses to start) instead of silently booting with the dev
    # signing key, which anyone with the source could use to forge a
    # DelegationToken. Dev environments (docker-compose.yml, the test suite) set
    # this; no deployed environment ever should. See docs/DEPLOYMENT.md §2.
    dev_mode: bool = False

    # Per-client rate limiting on write endpoints (ratelimit.py). In-memory and
    # per-process — single-instance broker is the v0 deployment shape (§2). Set
    # any limit to 0 to disable that rule. Defaults chosen for "comfortable for
    # honest agents and askers, fatal for an unattended flood":
    #   * register/hour:  3 — one human enrols once; mock-passport staging may
    #     reset more often. Conservative.
    #   * envelopes/min: 30 — agents poll every ~30s; even a chatty agent
    #     handling many open questions stays well under one per second.
    #   * revoke/min:    10 — override is sacred but human-rate.
    ratelimit_enabled: bool = True
    ratelimit_register_per_hour: int = 3
    ratelimit_envelopes_per_minute: int = 30
    ratelimit_revoke_per_minute: int = 10
    # Trust X-Real-IP / X-Forwarded-For for client identification. Only safe
    # behind a known proxy (Caddy, in the v0 deployment). Set False when the
    # broker is exposed directly — otherwise any client can forge their IP.
    ratelimit_trust_proxy_headers: bool = True


def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
