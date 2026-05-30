"""FastAPI app factory.

Run with:
    uvicorn hearme_broker.main:app --reload
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from .config import get_settings
from .db import close_pool, init_pool
from .ratelimit import RateLimitMiddleware, build_default_limiter
from .routes.envelopes import router as envelopes_router
from .routes.questions import router as questions_router
from .routes.register import router as register_router
from .routes.revocations import router as revocations_router
from .routes.stats import router as stats_router
from .self_revocations import SelfRevocationListener
from .startup_checks import enforce_production_config

log = logging.getLogger("hearme_broker.main")


def create_app() -> FastAPI:
    logging.basicConfig(level=logging.INFO)

    # Pre-flight: refuse to start in production mode with documented dev
    # defaults (dev signing key, dev DB password, dev-bypass route, etc.).
    # See startup_checks.py and docs/DEPLOYMENT.md §2.
    settings = get_settings()
    if settings.production_mode:
        enforce_production_config(settings)

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
    settings = get_settings()
    if settings.ratelimit_enabled:
        limiter = build_default_limiter(settings)
        app.add_middleware(
            RateLimitMiddleware,
            limiter=limiter,
            trust_proxy_headers=settings.ratelimit_trust_proxy_headers,
        )
        if list(limiter.configured_routes()):
            log.info(
                "ratelimit: enabled for %s (trust_proxy_headers=%s)",
                list(limiter.configured_routes()),
                settings.ratelimit_trust_proxy_headers,
            )

    app.include_router(questions_router)
    app.include_router(register_router)
    app.include_router(envelopes_router)
    app.include_router(revocations_router)
    app.include_router(stats_router)

    # DANGER: testing-only synthetic-identity registration. Off unless explicitly
    # enabled; never mount in production (see routes/dev.py and startup_checks.py).
    if settings.dev_insecure_register:
        from .routes.dev import router as dev_router

        app.include_router(dev_router)
        log.warning(
            "HEARME_BROKER_DEV_INSECURE_REGISTER=1 — POST /v1/dev/register is "
            "MOUNTED. Self proof-of-personhood is BYPASSED. Do NOT use in prod."
        )

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
