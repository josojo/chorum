// Observability wiring (issue #101): Prometheus counters, the /metrics endpoint,
// the 429 counter path, and the structured-logger config. No DB needed — the
// schema-invalid (422) and rate-limited (429) paths short-circuit before any
// query, and the record* helpers are pure.

import { describe, it, expect } from "vitest";

import { getSettings } from "../src/config";
import { buildLoggerConfig } from "../src/logging";
import { RejectionReason } from "../src/models";
import {
  recordOutcome,
  recordRateLimited,
  registry,
} from "../src/observability/metrics";
import { buildApp } from "../src/server";

// Read one counter series' current value from the shared registry (the metric
// objects are module-level singletons, so values accumulate across the file —
// assert on deltas, not absolutes).
async function counterValue(
  name: string,
  labels: Record<string, string>,
): Promise<number> {
  const metrics = await registry.getMetricsAsJSON();
  const m = metrics.find((x) => x.name === name);
  if (!m) return 0;
  const series = (m.values as Array<{ value: number; labels: Record<string, string> }>).find(
    (v) => Object.entries(labels).every(([k, val]) => v.labels[k] === val),
  );
  return series ? series.value : 0;
}

describe("metrics: record helpers", () => {
  it("counts outcomes per route and rejection reasons", async () => {
    const accBefore = await counterValue("chorum_broker_register_total", {
      outcome: "accepted",
    });
    const rejBefore = await counterValue("chorum_broker_rejections_total", {
      route: "register",
      reason: RejectionReason.SELF_PROOF_INVALID,
    });

    recordOutcome("register", true);
    recordOutcome("register", false, RejectionReason.SELF_PROOF_INVALID);

    expect(
      await counterValue("chorum_broker_register_total", { outcome: "accepted" }),
    ).toBe(accBefore + 1);
    expect(
      await counterValue("chorum_broker_register_total", { outcome: "rejected" }),
    ).toBeGreaterThan(0);
    expect(
      await counterValue("chorum_broker_rejections_total", {
        route: "register",
        reason: RejectionReason.SELF_PROOF_INVALID,
      }),
    ).toBe(rejBefore + 1);
  });

  it("does not record a reason on accept", async () => {
    const before = await counterValue("chorum_broker_rejections_total", {
      route: "revoke",
      reason: RejectionReason.ENVELOPE_NOT_FOUND,
    });
    // Idempotent revoke of a missing envelope is accepted=true with a reason —
    // it must NOT count as a rejection.
    recordOutcome("revoke", true, RejectionReason.ENVELOPE_NOT_FOUND);
    expect(
      await counterValue("chorum_broker_rejections_total", {
        route: "revoke",
        reason: RejectionReason.ENVELOPE_NOT_FOUND,
      }),
    ).toBe(before);
  });

  it("counts rate-limited requests by route", async () => {
    const before = await counterValue("chorum_broker_ratelimited_total", {
      route: "POST /v1/register",
    });
    recordRateLimited("POST /v1/register");
    expect(
      await counterValue("chorum_broker_ratelimited_total", {
        route: "POST /v1/register",
      }),
    ).toBe(before + 1);
  });
});

describe("GET /metrics endpoint", () => {
  it("serves the Prometheus exposition with broker + default series", async () => {
    const app = buildApp({ logger: false });
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.body).toContain("chorum_broker_register_total");
    expect(res.body).toContain("chorum_broker_rejections_total");
    // A default Node process metric is present too.
    expect(res.body).toContain("nodejs_");
    await app.close();
  });

  it("is absent when metrics are disabled", async () => {
    const settings = getSettings({ metricsEnabled: false });
    const app = buildApp({ settings, logger: false });
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("rate limiter increments the 429 counter", () => {
  it("records a 429 when the per-route limit is exceeded", async () => {
    // 1/hour: the first /v1/register passes the limiter (then 422s on the empty
    // body, no DB/bridge), subsequent ones are rejected with 429.
    const settings = getSettings({ ratelimitRegisterPerHour: 1 });
    const app = buildApp({ settings, logger: false });
    const before = await counterValue("chorum_broker_ratelimited_total", {
      route: "POST /v1/register",
    });

    let got429 = 0;
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ method: "POST", url: "/v1/register", payload: {} });
      if (res.statusCode === 429) got429++;
    }
    expect(got429).toBeGreaterThanOrEqual(1);
    expect(
      await counterValue("chorum_broker_ratelimited_total", {
        route: "POST /v1/register",
      }),
    ).toBeGreaterThanOrEqual(before + 1);
    await app.close();
  });
});

describe("structured logger config", () => {
  it("emits JSON with a service field, env level, and header redaction", () => {
    const cfg = buildLoggerConfig(getSettings({ logLevel: "warn" })) as {
      level: string;
      base: Record<string, unknown>;
      redact: { paths: string[]; remove: boolean };
    };
    expect(cfg.level).toBe("warn");
    expect(cfg.base.service).toBe("broker");
    expect(cfg.redact.paths).toContain("req.headers.authorization");
    expect(cfg.redact.remove).toBe(true);
  });
});
