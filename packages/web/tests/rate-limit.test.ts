// Tests for the per-client question-creation rate limiter (lib/rate-limit.ts).
//
// Two surfaces:
//   1. `checkRateLimit` — pure sliding-window decision, deterministic clock.
//   2. `clientIdFromHeaders` — Caddy-style header extraction with the trust
//      toggle, no Next-runtime dependency.

import { afterEach, describe, expect, it } from "vitest";
import {
  __resetRateLimitForTests,
  checkRateLimit,
  clientIdFromHeaders,
} from "../src/lib/rate-limit";

afterEach(() => {
  __resetRateLimitForTests();
});

// ---------- checkRateLimit (pure) ----------

describe("checkRateLimit", () => {
  it("admits exactly `limit` requests then denies with retryAfter", () => {
    const now = makeFakeClock(1_000_000_000_000);
    for (let i = 0; i < 3; i++) {
      const r = checkRateLimit("alice", { limit: 3, windowSeconds: 60, now });
      expect(r.ok).toBe(true);
    }
    const denied = checkRateLimit("alice", { limit: 3, windowSeconds: 60, now });
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      // Oldest request was just now → retry-after ≈ window length.
      expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(59);
      expect(denied.retryAfterSeconds).toBeLessThanOrEqual(60);
    }
  });

  it("admits again once the window slides past the oldest in-window request", () => {
    const clock = stepClock(1_000_000_000_000);
    expect(checkRateLimit("alice", { limit: 2, windowSeconds: 10, now: clock.now }).ok).toBe(true);
    clock.advance(3_000);
    expect(checkRateLimit("alice", { limit: 2, windowSeconds: 10, now: clock.now }).ok).toBe(true);
    // Both still in window — denied.
    expect(checkRateLimit("alice", { limit: 2, windowSeconds: 10, now: clock.now }).ok).toBe(false);
    // Step just past the oldest's expiry — capacity reopens.
    clock.advance(8_000);
    expect(checkRateLimit("alice", { limit: 2, windowSeconds: 10, now: clock.now }).ok).toBe(true);
  });

  it("keeps separate clients independent (one flood does not poison another)", () => {
    const now = makeFakeClock(1_000_000_000_000);
    // Alice exhausts.
    expect(checkRateLimit("alice", { limit: 1, windowSeconds: 60, now }).ok).toBe(true);
    expect(checkRateLimit("alice", { limit: 1, windowSeconds: 60, now }).ok).toBe(false);
    // Bob is fresh.
    expect(checkRateLimit("bob", { limit: 1, windowSeconds: 60, now }).ok).toBe(true);
  });

  it("limit=0 disables the rule entirely", () => {
    const now = makeFakeClock(1_000_000_000_000);
    for (let i = 0; i < 1000; i++) {
      expect(checkRateLimit("alice", { limit: 0, windowSeconds: 60, now }).ok).toBe(true);
    }
  });
});

// ---------- clientIdFromHeaders ----------

describe("clientIdFromHeaders", () => {
  it("prefers x-real-ip, then first hop of x-forwarded-for", () => {
    const h = new Headers({
      "x-real-ip": "1.1.1.1",
      "x-forwarded-for": "2.2.2.2, 3.3.3.3",
    });
    expect(clientIdFromHeaders(h)).toBe("1.1.1.1");

    expect(
      clientIdFromHeaders(new Headers({ "x-forwarded-for": "9.9.9.9, 8.8.8.8" })),
    ).toBe("9.9.9.9");
  });

  it("falls back to 'unknown' when there are no proxy headers", () => {
    expect(clientIdFromHeaders(new Headers())).toBe("unknown");
  });

  it("ignores proxy headers when trust is disabled via env", () => {
    const prev = process.env.CHORUM_WEB_TRUST_PROXY_HEADERS;
    process.env.CHORUM_WEB_TRUST_PROXY_HEADERS = "false";
    try {
      const h = new Headers({ "x-real-ip": "1.1.1.1", "x-forwarded-for": "2.2.2.2" });
      expect(clientIdFromHeaders(h)).toBe("unknown");
    } finally {
      if (prev === undefined) delete process.env.CHORUM_WEB_TRUST_PROXY_HEADERS;
      else process.env.CHORUM_WEB_TRUST_PROXY_HEADERS = prev;
    }
  });
});

// ---------- helpers ----------

function makeFakeClock(epochMs: number): () => number {
  // Constant-time clock — every call returns the same value. Use this when
  // the test exercises requests bursting at the SAME instant.
  return () => epochMs;
}

function stepClock(epochMs: number): { now: () => number; advance: (ms: number) => void } {
  let t = epochMs;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}
