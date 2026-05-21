"""Dev runner — boots the skill loop with stub or real Hermes host adapters.

Two modes:

* **Stub mode** (default): uses ``FakeLLMClient`` and ``Mem0StubProvider``
  so ``docker compose up`` produces a working e2e flow without any
  network LLM calls. This is also what CI exercises by default (per
  ARCHITECTURE.md §12 "never live LLM in CI").
* **Hermes mode** (``HEARME_USE_HERMES=1``): instantiates a real
  ``hermes_agent.AIAgent`` via ``HermesLLMClient`` and a
  ``HermesMemoryProvider``. Requires ``OPEN_ROUTER_API_KEY`` (or
  ``OPENROUTER_API_KEY``) in the environment.

Real Hermes integration eventually replaces this entrypoint entirely:
when the skill is loaded inside Hermes via the ``hermes.skills`` entry
point, Hermes hands ``skill.entrypoint`` a host with its own LLM, memory,
and channel. This module exists for the standalone-skill case (Docker
Compose dev, the e2e test).
"""

from __future__ import annotations

import asyncio
import logging
import os

from .config import get_settings
from .llm.client import FakeLLMClient
from .memory.mem0_stub import Mem0StubProvider
from .skill import build_configured_memory, run_loop
from .ui import InMemoryChannel

log = logging.getLogger("hearme_skill.dev_runner")


class _AutoApproveChannel(InMemoryChannel):
    """Auto-replies 'ok' to every prompt — dev only.

    A real channel surfaces the prompt to the user (Telegram, browser push,
    etc.); this stub stands in so the loop doesn't block waiting for input.
    """

    async def prompt(self, message: str, *, timeout_seconds: float | None = None) -> str | None:
        self.sent.append(message)
        return "ok"


def _truthy(value: str | None) -> bool:
    if not value:
        return False
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _build_hermes_host() -> "_DevHost":
    """Construct a host that routes the Answerer through real Hermes."""

    # Import lazily so the stub-mode path doesn't require hermes-agent.
    from .llm.hermes_client import HermesLLMClient
    from .memory.hermes_provider import HermesMemoryProvider

    if not (os.environ.get("OPENROUTER_API_KEY") or os.environ.get("OPEN_ROUTER_API_KEY")):
        raise RuntimeError(
            "HEARME_USE_HERMES=1 but no OPEN_ROUTER_API_KEY / OPENROUTER_API_KEY in env. "
            "Add the key to your .env or export it before starting the skill."
        )

    llm = HermesLLMClient()
    memory_mode = os.environ.get("HEARME_HERMES_MEMORY_MODE", "passthrough")
    memory = HermesMemoryProvider(
        mode="extract" if memory_mode == "extract" else "passthrough",
        llm=llm if memory_mode == "extract" else None,
    )
    return _DevHost(llm=llm, memory=memory)


class _DevHost:
    """Minimal host shape the skill's ``run_loop`` expects (see skill.py)."""

    def __init__(self, llm=None, memory=None) -> None:
        self.llm = llm if llm is not None else FakeLLMClient()
        self.memory = memory if memory is not None else Mem0StubProvider()
        self.channel = _AutoApproveChannel()
        self.node_id = os.environ.get("HEARME_SKILL_NODE_ID", "dev-host-0")


def _build_default_host() -> _DevHost:
    if _truthy(os.environ.get("HEARME_USE_HERMES")):
        log.info("HEARME_USE_HERMES=1 — booting real Hermes-backed host")
        return _build_hermes_host()
    memory = build_configured_memory(get_settings())
    log.info("standalone host (FakeLLMClient + %s)", getattr(memory, "name", type(memory).__name__))
    return _DevHost(memory=memory)


def main() -> None:
    logging.basicConfig(
        level=os.environ.get("HEARME_SKILL_LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    asyncio.run(run_loop(_build_default_host()))


if __name__ == "__main__":
    main()
