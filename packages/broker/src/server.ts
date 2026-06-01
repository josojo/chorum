// Fastify app factory + lifecycle. TypeScript port of main.py.
//
// buildApp() wires routes, the rate-limit hook, and /healthz, but does NOT touch
// the DB or listen — tests call initDb() + app.inject() themselves. main() is the
// production entrypoint: it runs the startup checks, opens the DB, starts the
// Self revocation listener, and listens on :8000.

import Fastify, { type FastifyInstance } from "fastify";

import { type Settings, getSettings } from "./config";
import { closeDb, initDb, getDb } from "./db";
import { buildDefaultLimiter, registerRateLimit } from "./ratelimit";
import { enforceProductionConfig } from "./startupChecks";
import { SelfRevocationListener } from "./selfRevocations";
import type { VerifySelfProof } from "./verify/bridgeClient";
import { registerQuestionsRoutes } from "./routes/questions";
import { registerRegisterRoutes } from "./routes/register";
import { registerEnvelopesRoutes } from "./routes/envelopes";
import { registerRevocationsRoutes } from "./routes/revocations";
import { registerStatsRoutes } from "./routes/stats";
import { registerAskersRoutes } from "./routes/askers";
import { registerDevRoutes } from "./routes/dev";

export interface BuildAppOptions {
  settings?: Settings;
  // Injectable bridge verifier (tests run /v1/register without a real bridge).
  verifyProof?: VerifySelfProof;
  logger?: boolean;
}

export function buildApp(opts: BuildAppOptions = {}): FastifyInstance {
  const settings = opts.settings ?? getSettings();
  const app = Fastify({ logger: opts.logger ?? true });

  if (settings.ratelimitEnabled) {
    const limiter = buildDefaultLimiter(settings);
    registerRateLimit(app, {
      limiter,
      trustProxyHeaders: settings.ratelimitTrustProxyHeaders,
    });
    if (limiter.configuredRoutes().length > 0) {
      app.log.info(
        { routes: limiter.configuredRoutes(), trustProxyHeaders: settings.ratelimitTrustProxyHeaders },
        "ratelimit: enabled",
      );
    }
  }

  registerQuestionsRoutes(app);
  registerRegisterRoutes(app, { verifyProof: opts.verifyProof });
  registerEnvelopesRoutes(app);
  registerRevocationsRoutes(app);
  registerStatsRoutes(app);
  registerAskersRoutes(app, { settings });

  // DANGER: testing-only synthetic-identity registration. Off unless explicitly
  // enabled; never mount in production (see routes/dev.ts and startupChecks.ts).
  if (settings.devInsecureRegister) {
    registerDevRoutes(app);
    app.log.warn(
      "HEARME_BROKER_DEV_INSECURE_REGISTER=1 — POST /v1/dev/register is MOUNTED. " +
        "Self proof-of-personhood is BYPASSED. Do NOT use in prod.",
    );
  }

  app.get("/healthz", async () => ({ status: "ok" }));

  return app;
}

async function main(): Promise<void> {
  const settings = getSettings();

  // Pre-flight: refuse to start in production mode with documented dev defaults.
  if (settings.productionMode) {
    enforceProductionConfig(settings);
  }

  await initDb();
  const app = buildApp({ settings });

  const listener = new SelfRevocationListener({ db: getDb(), settings, log: app.log });
  listener.start();

  const shutdown = async (signal: string) => {
    app.log.info(`received ${signal}, shutting down`);
    try {
      await app.close();
      await listener.stop();
      await closeDb();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ host: "0.0.0.0", port: 8000 });
}

// Run only when executed directly (node dist/server.js), not when imported by tests.
import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}

export { buildApp as createApp };
