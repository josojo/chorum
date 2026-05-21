"""FastAPI app factory.

Run with:
    uvicorn hearme_broker.main:app --reload
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from .db import close_pool, init_pool
from .routes.envelopes import router as envelopes_router
from .routes.questions import router as questions_router
from .routes.register import router as register_router
from .self_revocations import SelfRevocationListener


def create_app() -> FastAPI:
    logging.basicConfig(level=logging.INFO)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        pool = await init_pool()
        listener = SelfRevocationListener(pool=pool)
        listener.start()
        try:
            yield
        finally:
            await listener.stop()
            await close_pool()

    app = FastAPI(
        title="hearme-broker",
        version="0.0.1",
        lifespan=lifespan,
        description="Hearme v0 dispatcher and envelope verifier. See ARCHITECTURE.md §5.",
    )
    app.include_router(questions_router)
    app.include_router(register_router)
    app.include_router(envelopes_router)

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
