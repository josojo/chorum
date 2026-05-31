"""Per-client rate limiting (v0 — basic public-API hygiene).

The composite PK on ``envelopes`` already stops duplicate Sybil writes at the
DB layer (ARCHITECTURE.md §3), but the *verify pipeline* still runs per
request (delegation signature checks, registry reads, eligibility, agent
signature verify), and ``/v1/register`` does a real Self-bridge round-trip.
A single attacker can burn CPU / DB / bridge calls with bogus posts. This
module is the v0 bound on that: per-client sliding-window quotas on the
write endpoints.

The limiter is **in-memory and per-process**. That is the right v0 choice
(single-instance broker per ARCHITECTURE §2; no new infra) and the wrong
mainnet choice (lost on restart; does not aggregate across replicas). The
follow-up is Redis or a shared cache — but the policy surface defined here
stays the same.

What it limits:
  * ``POST /v1/register``           — registration is the most expensive path
    (Self-bridge call + on-chain Celo read), kept tight.
  * ``POST /v1/envelopes``          — the high-volume hot path; per-IP cap
    bounds a flood of bogus envelopes from one source.
  * ``POST /v1/envelopes/revoke``   — same shape as envelopes; bound the
    same way (it is also a signed write that runs verification).

What it does **not** limit:
  * Read endpoints (``GET /v1/questions/open``, ``GET /v1/stats``,
    ``/healthz``). Agents poll these on their own cadence and they have no
    per-request side effects; rate-limiting them would hurt honest agents
    while doing nothing about a DoS that can just open more connections.

Client identification (``X-Real-IP`` then ``X-Forwarded-For`` then peer)
matches the v0 deployment shape (Caddy in front, single host — see
``Caddyfile``). If the broker is ever exposed without a trusted proxy,
``X-Real-IP`` MUST NOT be honored — operators can disable header trust by
setting ``ratelimit_trust_proxy_headers=False``.
"""

from __future__ import annotations

import logging
import time
from collections import deque
from dataclasses import dataclass, field
from threading import Lock
from typing import Iterable

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

log = logging.getLogger("hearme_broker.ratelimit")


@dataclass(frozen=True)
class Rule:
    """A ``(limit, window_seconds)`` quota for one route pattern.

    Sliding window: at most ``limit`` requests from any single client in
    any ``window_seconds`` interval. A 0 ``limit`` disables the rule
    (used as the default for unlisted routes).
    """

    limit: int
    window_seconds: float


@dataclass
class SlidingWindow:
    """One client's request timestamps inside a single window.

    The deque holds Unix seconds; ``allow()`` evicts everything older than
    ``window_seconds`` from the front, then admits-or-denies based on the
    deque's length. O(k) per call where k is the number of expired entries
    to evict — amortized O(1) under steady-state load.
    """

    rule: Rule
    timestamps: deque[float] = field(default_factory=deque)

    def allow(self, now: float) -> tuple[bool, float]:
        """Return ``(allowed, retry_after_seconds)``.

        On admit, ``retry_after_seconds`` is 0. On deny, it is the time
        until the oldest in-window request would expire — what a polite
        client uses to back off.
        """
        cutoff = now - self.rule.window_seconds
        while self.timestamps and self.timestamps[0] <= cutoff:
            self.timestamps.popleft()
        if len(self.timestamps) < self.rule.limit:
            self.timestamps.append(now)
            return True, 0.0
        # The oldest in-window request expires at: oldest + window.
        retry_in = (self.timestamps[0] + self.rule.window_seconds) - now
        return False, max(retry_in, 0.0)


class RateLimiter:
    """In-memory, per-(route, client) sliding-window limiter.

    Thread-safe (uses a single coarse lock; fine for v0 — Python's GIL
    means this is rarely a bottleneck and contention is bounded by the
    number of *unique* (route, client) tuples touching the limiter, not
    the request rate).
    """

    def __init__(self, rules: dict[str, Rule], *, now_fn=time.monotonic) -> None:
        self._rules = rules
        self._now = now_fn
        self._windows: dict[tuple[str, str], SlidingWindow] = {}
        self._lock = Lock()

    def configured_routes(self) -> Iterable[str]:
        return self._rules.keys()

    def check(self, *, route: str, client_id: str) -> tuple[bool, float]:
        """Decide one request. Returns ``(allowed, retry_after_seconds)``."""
        rule = self._rules.get(route)
        if rule is None or rule.limit <= 0:
            return True, 0.0
        key = (route, client_id)
        with self._lock:
            window = self._windows.get(key)
            if window is None or window.rule != rule:
                window = SlidingWindow(rule=rule)
                self._windows[key] = window
            return window.allow(self._now())

    # Testing helper — kept tiny so the production path doesn't grow.
    def reset(self) -> None:
        with self._lock:
            self._windows.clear()


def client_id_from_request(req: Request, *, trust_proxy_headers: bool) -> str:
    """Best-effort client identifier (an IP, in v0).

    Behind a trusted proxy (Caddy in the v0 deployment) the immediate peer is
    the proxy, so we prefer ``X-Real-IP`` then the first hop in
    ``X-Forwarded-For``. Disable ``trust_proxy_headers`` when the broker is
    exposed directly — otherwise *any client* can forge the header.
    """
    if trust_proxy_headers:
        real = req.headers.get("x-real-ip")
        if real:
            return real.strip()
        xff = req.headers.get("x-forwarded-for")
        if xff:
            return xff.split(",")[0].strip()
    if req.client and req.client.host:
        return req.client.host
    return "unknown"


class RateLimitMiddleware(BaseHTTPMiddleware):
    """Apply the limiter to write endpoints; pass everything else through."""

    def __init__(self, app, *, limiter: RateLimiter, trust_proxy_headers: bool) -> None:
        super().__init__(app)
        self.limiter = limiter
        self.trust_proxy_headers = trust_proxy_headers

    async def dispatch(self, request: Request, call_next):
        route = f"{request.method} {request.url.path}"
        if route not in self.limiter._rules:  # noqa: SLF001 — same module
            return await call_next(request)
        client = client_id_from_request(request, trust_proxy_headers=self.trust_proxy_headers)
        allowed, retry_after = self.limiter.check(route=route, client_id=client)
        if allowed:
            return await call_next(request)
        retry_seconds = max(1, int(retry_after + 0.5))
        log.info(
            "ratelimit: route=%s client=%s retry_after=%ss",
            route,
            client,
            retry_seconds,
        )
        return JSONResponse(
            status_code=429,
            headers={"Retry-After": str(retry_seconds)},
            content={"error": "rate_limited", "retry_after_seconds": retry_seconds},
        )


def build_default_limiter(settings) -> RateLimiter:
    """Construct the limiter from broker settings.

    Limits encoded as ``(limit, window_seconds)`` integers in settings so
    operators can tune without parsing a string DSL. Setting any limit to
    0 disables the rule for that route.
    """
    rules: dict[str, Rule] = {}
    if settings.ratelimit_register_per_hour > 0:
        rules["POST /v1/register"] = Rule(
            limit=settings.ratelimit_register_per_hour, window_seconds=3600
        )
    if settings.ratelimit_envelopes_per_minute > 0:
        rules["POST /v1/envelopes"] = Rule(
            limit=settings.ratelimit_envelopes_per_minute, window_seconds=60
        )
    if settings.ratelimit_revoke_per_minute > 0:
        rules["POST /v1/envelopes/revoke"] = Rule(
            limit=settings.ratelimit_revoke_per_minute, window_seconds=60
        )
    return RateLimiter(rules=rules)
