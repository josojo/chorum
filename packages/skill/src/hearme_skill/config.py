"""Skill runtime configuration.

Defaults assume the broker is running locally per `docker-compose.yml`. All
file paths sit under `~/.hermes/hearme/` by default; override via env vars
with the `HEARME_SKILL_` prefix.
"""

from __future__ import annotations

from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


def _default_root() -> Path:
    return Path.home() / ".hermes" / "hearme"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="HEARME_SKILL_", extra="ignore")

    broker_url: str = Field(default="http://localhost:8000")
    # self-bridge used during onboarding to create the Self requests the phone
    # scans and to collect the relayed proofs. Not contacted in steady state
    # (registration posts the proofs to the broker's /v1/register).
    self_bridge_url: str = Field(default="http://localhost:8787")
    poll_interval_seconds: float = 30.0
    # § 1.12 override is sacred. 0 = always prompt. Non-zero = preview window
    # in which the user can veto before auto-submit.
    auto_submit_window_seconds: int = 0

    root_dir: Path = Field(default_factory=_default_root)
    # Memory provider selection for standalone/dev hosts:
    # "stub" keeps the deterministic test provider, "chatgpt-export" reads the
    # local SQLite DB produced by `hearme-skill chatgpt-import`.
    memory_backend: str = Field(default="stub")

    @property
    def policy_path(self) -> Path:
        return self.root_dir / "policy.yaml"

    @property
    def delegation_path(self) -> Path:
        return self.root_dir / "delegation.token"

    @property
    def agent_key_path(self) -> Path:
        return self.root_dir / "agent_key"

    @property
    def ledger_path(self) -> Path:
        return self.root_dir / "ledger.sqlite"

    @property
    def chatgpt_memory_path(self) -> Path:
        return self.root_dir / "chatgpt_memory.sqlite"


def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
