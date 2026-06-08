// Prometheus metrics for the broker (issue #101).
//
// A dedicated registry (not prom-client's global default) holds:
//   - default Node process metrics (rss, event-loop lag, GC, fd count, ...)
//   - chorum_broker_* request counters
//
// Exposed at GET /metrics on :8000. INTERNAL-ONLY: the Caddyfile routes only
// /v1/*, /self/*, and the web default, so /metrics never reaches the public
// internet; Prometheus scrapes broker:8000/metrics over the compose network.
//
// The metric objects are module-level singletons created once at import. Route
// handlers call the record* helpers; buildApp() mounts the endpoint. Keeping the
// objects at module scope (and on a private registry) means repeated buildApp()
// calls across tests don't re-register a metric — prom-client throws on that.

import { Counter, Registry, collectDefaultMetrics } from "prom-client";
import type { FastifyInstance } from "fastify";

import type { RejectionReason } from "../models";

export const registry = new Registry();
registry.setDefaultLabels({ service: "broker" });
collectDefaultMetrics({ register: registry });

// One counter per write route. outcome = "accepted" | "rejected"; the rate() of
// each series is the per-endpoint throughput the issue asks for (register rate,
// envelope ingest rate, revoke rate).
const registerTotal = new Counter({
  name: "chorum_broker_register_total",
  help: "POST /v1/register attempts, by outcome (accepted|rejected).",
  labelNames: ["outcome"],
  registers: [registry],
});
const envelopesTotal = new Counter({
  name: "chorum_broker_envelopes_total",
  help: "POST /v1/envelopes attempts, by outcome (accepted|rejected).",
  labelNames: ["outcome"],
  registers: [registry],
});
const revokeTotal = new Counter({
  name: "chorum_broker_revoke_total",
  help: "POST /v1/envelopes/revoke attempts, by outcome (accepted|rejected).",
  labelNames: ["outcome"],
  registers: [registry],
});

// Verification-failure breakdown (issue: "by RejectionReason"). One series per
// (route, reason) so a spike in, say, self_proof_invalid stands on its own. The
// reason set is the bounded RejectionReason enum, so cardinality stays small.
const rejectionsTotal = new Counter({
  name: "chorum_broker_rejections_total",
  help: "Rejected requests, by route and RejectionReason.",
  labelNames: ["route", "reason"],
  registers: [registry],
});

// 429 rate (rate-limit pressure), labeled by the limited route.
const rateLimitedTotal = new Counter({
  name: "chorum_broker_ratelimited_total",
  help: "Requests rejected by the rate limiter (HTTP 429), by route.",
  labelNames: ["route"],
  registers: [registry],
});

export type WriteRoute = "register" | "envelopes" | "revoke";
const totals: Record<WriteRoute, Counter<"outcome">> = {
  register: registerTotal,
  envelopes: envelopesTotal,
  revoke: revokeTotal,
};

// Record one terminal outcome for a write route. `reason` is the TRUE internal
// reason: record it even when CHORUM_BROKER_EXPOSE_REJECTION_REASONS=0 hides it
// from the caller (the whole point is to see internally what callers can't).
// Pass it for every rejection; omit/null on accept.
export function recordOutcome(
  route: WriteRoute,
  accepted: boolean,
  reason?: RejectionReason | null,
): void {
  totals[route].inc({ outcome: accepted ? "accepted" : "rejected" });
  if (!accepted && reason) {
    rejectionsTotal.inc({ route, reason });
  }
}

// Record a 429. `route` is the limiter's "METHOD /path" key.
export function recordRateLimited(route: string): void {
  rateLimitedTotal.inc({ route });
}

// GET /metrics — Prometheus text exposition. No auth: internal-only (see header).
export function registerMetricsRoute(app: FastifyInstance): void {
  app.get("/metrics", async (_req, reply) => {
    reply.header("Content-Type", registry.contentType);
    return registry.metrics();
  });
}
