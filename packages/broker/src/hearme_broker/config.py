"""Broker runtime configuration.

Environment-driven. The DATABASE_URL points at the shared Postgres using the
``hearme_broker`` role (see /db/init/02-roles.sql and the README).
"""

from __future__ import annotations

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


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

    # zkpassport-bridge: the Node sidecar that runs the real Noir/UltraHonk
    # verifier. The broker re-verifies every proof here. Point this at a bridge
    # instance the broker controls (never trust the agent's verification).
    zkpassport_bridge_url: str = Field(
        default="http://localhost:8787",
        description="Base URL of the zkpassport-bridge POST /verify endpoint.",
    )
    zkpassport_verify_timeout_seconds: float = 30.0


def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
