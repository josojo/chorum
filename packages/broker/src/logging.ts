// Structured (JSON) logging config for the broker's pino logger.
//
// Issue #101 / DEPLOYMENT.md §5 ask for "switch the broker formatter to JSON".
// Fastify's default logger already emits newline-delimited JSON, but the default
// is implicit and unconfigured. This makes the choice deliberate and adds the
// three things a real log backend wants:
//
//   1. A `service` field on every line, so a shared backend can split the
//      broker's stream from web / self-bridge / classifier.
//   2. An env-tunable level (HEARME_BROKER_LOG_LEVEL) — default "info", drop to
//      "warn" to quiet a noisy prod box or "debug" to chase an incident.
//   3. Redaction of credential-bearing request headers, so an Authorization or
//      Cookie value can never be serialized into a log line.
//
// buildApp() passes this to Fastify unless logging is disabled (tests pass
// `logger: false`).

import type { FastifyServerOptions } from "fastify";

import type { Settings } from "./config";

// The non-boolean branch of Fastify's `logger` option (a pino options object).
export type LoggerConfig = Exclude<FastifyServerOptions["logger"], boolean | undefined>;

export function buildLoggerConfig(settings: Settings): LoggerConfig {
  return {
    level: settings.logLevel,
    // Stamped on every line. Fastify already adds pid/hostname; this names the
    // process so multi-service log streams stay separable.
    base: { service: "broker" },
    redact: {
      paths: ["req.headers.authorization", "req.headers.cookie"],
      remove: true,
    },
  };
}
