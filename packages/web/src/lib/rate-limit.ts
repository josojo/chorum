// Per-client rate limiting for write server actions.
//
// v0 — basic spam mitigation on question creation while asker auth stays
// deferred (ARCHITECTURE §11). The composite point is the same as on the
// broker (packages/broker/src/ratelimit.ts): an in-memory,
// per-process sliding window — appropriate for the single-instance v0
// deployment, NOT a substitute for a shared cache (Redis) once we scale
// horizontally. The policy API stays the same when we swap the backing.
//
// Why per-IP (not per-display-name): there is no asker auth in v0, so the
// display name is freely chosen per-request and can be rotated infinitely
// by an attacker. The IP, behind Caddy, is the only stable signal we have.
//
// Why server-only: the limiter holds in-process state and must never be
// shipped to a client bundle. The module is intentionally framework-free
// (no `next/headers` import) so it can be unit-tested without Next.

const DEFAULT_LIMIT = Number(process.env.CHORUM_WEB_RATELIMIT_QUESTIONS_PER_HOUR ?? 5);
const WINDOW_SECONDS = 3600;

type Window = number[]; // unix-seconds timestamps within the window

// One global map per Node process — the singleton is fine here because each
// edge/Node worker has its own and the limit is per-worker.
const windows: Map<string, Window> = new Map();

export type RateLimitResult =
  | { ok: true }
  | { ok: false; retryAfterSeconds: number };

/**
 * Decide one write for `clientId`. `now` injected for tests; defaults to
 * `Date.now()`. Sliding-window semantics: at most `limit` writes from any
 * single client in any `windowSeconds` interval.
 */
export function checkRateLimit(
  clientId: string,
  {
    limit = DEFAULT_LIMIT,
    windowSeconds = WINDOW_SECONDS,
    now = Date.now,
  }: { limit?: number; windowSeconds?: number; now?: () => number } = {},
): RateLimitResult {
  if (limit <= 0) return { ok: true }; // disabled
  const nowSec = now() / 1000;
  const cutoff = nowSec - windowSeconds;
  const existing = windows.get(clientId) ?? [];
  // Evict expired — keeps the array bounded by `limit`.
  let i = 0;
  while (i < existing.length && existing[i] <= cutoff) i++;
  const trimmed = i === 0 ? existing : existing.slice(i);
  if (trimmed.length < limit) {
    trimmed.push(nowSec);
    windows.set(clientId, trimmed);
    return { ok: true };
  }
  // Oldest in-window request expires at `trimmed[0] + windowSeconds`.
  const retryAfterSeconds = Math.max(1, Math.ceil(trimmed[0] + windowSeconds - nowSec));
  windows.set(clientId, trimmed);
  return { ok: false, retryAfterSeconds };
}

/**
 * Best-effort client identifier (an IP, in v0). Behind a trusted proxy
 * (Caddy in the v0 deployment) the immediate connection is the proxy,
 * so we honor `x-real-ip` then the first hop in `x-forwarded-for`.
 *
 * When `CHORUM_WEB_TRUST_PROXY_HEADERS=false` we fall back to a literal
 * "unknown" — which collapses every direct caller to a single bucket. That
 * is the right failure mode for "we don't know the IP": a flood from one
 * unauthenticated source still gets limited, at the cost of false-positive
 * blocks under genuine concurrent traffic. Don't deploy that way.
 */
export function clientIdFromHeaders(h: Headers): string {
  const trustProxy = (process.env.CHORUM_WEB_TRUST_PROXY_HEADERS ?? "true") !== "false";
  if (trustProxy) {
    const real = h.get("x-real-ip");
    if (real) return real.trim();
    const xff = h.get("x-forwarded-for");
    if (xff) return xff.split(",")[0]!.trim();
  }
  return "unknown";
}

/** Test-only — reset the in-memory state between cases. */
export function __resetRateLimitForTests(): void {
  windows.clear();
}
