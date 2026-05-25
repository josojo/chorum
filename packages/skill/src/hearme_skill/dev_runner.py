"""Dev runner — boots the skill loop with stub host adapters.

This is a **development-only** harness. It runs the linear pipeline
(policy → persona → answerer → envelope → submission) against a real broker
using ``FakeLLMClient`` and ``Mem0StubProvider``, so ``python -m
hearme_skill.dev_runner`` exercises the flow with no network LLM and no API key
(per ARCHITECTURE.md §12 "never live LLM in CI").

**Production answering does NOT use this loop.** In production the skill is a
Hermes plugin (``plugin.py``): a Hermes cron job (``schedule.py``) fires on a
schedule and the host agent answers questions through the ``hearme`` toolset
using its own configured model — no second API key, no standalone process.
"""

from __future__ import annotations

import asyncio
import logging
import os

from .config import get_settings
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


class _DevHost:
    """Minimal host shape the skill's ``run_loop`` expects (see skill.py)."""

    def __init__(self) -> None:
        from .llm.client import FakeLLMClient

        self.llm = FakeLLMClient()
        self.memory = build_configured_memory(get_settings()) or Mem0StubProvider()
        self.channel = _AutoApproveChannel()
        self.node_id = os.environ.get("HEARME_SKILL_NODE_ID", "dev-host-0")


def main() -> None:
    logging.basicConfig(
        level=os.environ.get("HEARME_SKILL_LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    log.info("standalone DEV host (FakeLLMClient) — production uses the Hermes plugin")
    asyncio.run(run_loop(_DevHost()))


if __name__ == "__main__":
    main()
