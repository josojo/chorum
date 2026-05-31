"""FastAPI app factory.

Run with:
    uvicorn hearme_broker.main:app --reload
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import JSONResponse

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

# Hard cap on request bodies. The largest legitimate body is an EnrollmentBundle
# (a few Self proofs); 16 KiB is generous headroom. A multi-MB answer/proof would
# otherwise be parsed, verified, stored, and force large aggregate recomputes
# (DoS / oversized rows) even within the rate limit. Enforced in the app so the
# guarantee holds regardless of any proxy (a Caddy `request_body { max_size 16KB }`
# is useful belt-and-suspenders but is not relied upon here).
MAX_BODY_BYTES = 16 * 1024


class BodySizeLimitMiddleware:
    """Pure-ASGI middleware rejecting oversized request bodies with HTTP 413.

    Checks the declared ``Content-Length`` up front, and also counts bytes off
    the receive stream so a chunked/streamed body that lies about (or omits) its
    length is still capped before a handler can read past the limit.
    """

    def __init__(self, app, max_body_bytes: int = MAX_BODY_BYTES) -> None:
        self.app = app
        self.max_body_bytes = max_body_bytes

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        # Fast path: trust a declared Content-Length that already exceeds the cap.
        for name, value in scope.get("headers", []):
            if name == b"content-length":
                try:
                    if int(value) > self.max_body_bytes:
                        await self._reject(send)
                        return
                except ValueError:
                    await self._reject(send)
                    return
                break

        received = 0
        rejected = False

        async def limited_receive():
            # Cap a chunked/streamed body that lies about (or omits) its length:
            # once the running total passes the limit, stop the stream and signal
            # the wrapped send to emit a 413 instead of the handler's response.
            nonlocal received, rejected
            message = await receive()
            if message.get("type") == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_body_bytes:
                    rejected = True
                    return {"type": "http.disconnect"}
            return message

        response_started = False

        async def guarded_send(message):
            # If we tripped the limit mid-stream, swallow the handler's output and
            # send a single 413 instead. Otherwise pass through unchanged.
            nonlocal response_started
            if rejected:
                if not response_started:
                    response_started = True
                    await self._reject(send)
                return
            await send(message)

        await self.app(scope, limited_receive, guarded_send)

        # The body exceeded the limit but the handler returned without sending
        # anything (e.g. it never read the body) — still fail closed with 413.
        if rejected and not response_started:
            await self._reject(send)

    async def _reject(self, send) -> None:
        response = JSONResponse(
            status_code=413,
            content={"detail": "request body too large"},
        )
        await response({"type": "http"}, self._empty_receive, send)

    @staticmethod
    async def _empty_receive():
        return {"type": "http.request", "body": b"", "more_body": False}


def create_app() -> FastAPI:
    logging.basicConfig(level=logging.INFO)

    # Pre-flight: refuse to start with documented dev defaults (dev signing key,
    # dev DB password, dev-bypass route, oracle-mode rejection reasons, registry
    # confirmation off). This runs BY DEFAULT and fails closed — the only way to
    # boot with dev defaults is to explicitly opt out via HEARME_BROKER_DEV_MODE=1,
    # which no deployed environment should ever set. See startup_checks.py and
    # docs/DEPLOYMENT.md §2.
    settings = get_settings()
    if settings.dev_mode:
        log.warning(
            "HEARME_BROKER_DEV_MODE=1 — skipping production startup checks. "
            "The broker may be running with dev defaults (dev signing key, dev "
            "DB password, oracle-mode rejection reasons). This must NEVER be set "
            "in a deployed environment."
        )
    else:
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

    # Cap request bodies before any handler reads them (DoS / oversized rows).
    app.add_middleware(BodySizeLimitMiddleware, max_body_bytes=MAX_BODY_BYTES)

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
