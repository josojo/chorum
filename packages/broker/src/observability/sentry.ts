// Sentry error tracking for the broker (issue #101).
//
// ENV-GATED, fail-open: initSentry() is a no-op unless SENTRY_DSN is set, so this
// is safe to ship before a Sentry project/DSN exists — nothing breaks, nothing
// is sent. When unset, captureException()/flushSentry() are also no-ops. When the
// DSN IS set, @sentry/node's default integrations additionally install
// process-level uncaughtException / unhandledRejection handlers, which is exactly
// the "unhandled exceptions" the issue asks to track; per-request Fastify errors
// are forwarded by the onError hook in server.ts.
//
// Config is the conventional SENTRY_* env namespace (NOT CHORUM_BROKER_*), so the
// same names work for the web / self-bridge / classifier services in follow-ups.

import * as Sentry from "@sentry/node";

let enabled = false;

export function initSentry(): boolean {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return false;
  Sentry.init({
    dsn,
    serverName: "broker",
    environment:
      process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "development",
    // Pin the release to the deployed git SHA when the deploy provides it (§7),
    // so an error groups to the exact build that produced it.
    release: process.env.SENTRY_RELEASE || process.env.CHORUM_DEPLOY_SHA,
    // Error tracking only by default; opt into tracing via the env var.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || "0"),
  });
  enabled = true;
  return true;
}

export function sentryEnabled(): boolean {
  return enabled;
}

export function captureException(
  err: unknown,
  context?: Record<string, unknown>,
): void {
  if (!enabled) return;
  Sentry.captureException(err, context ? { extra: context } : undefined);
}

// Drain the transport on shutdown so an error logged just before SIGTERM is not
// lost. No-op (returns immediately) when Sentry is disabled.
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!enabled) return;
  await Sentry.flush(timeoutMs);
}
