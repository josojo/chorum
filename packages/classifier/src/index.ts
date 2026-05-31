// Worker entrypoint. Boot sequence:
//   1. Load config (env vars; fails fast if anything is missing).
//   2. Open DB pool + OpenRouter client.
//   3. Run one tick OR loop forever, wired to SIGTERM/SIGINT for clean drain.

import { loadConfig, ConfigError } from "./config.js";
import { createDb } from "./db.js";
import { createOpenRouterClient } from "./openrouter.js";
import { runForever, runOnce } from "./worker.js";
import { log } from "./log.js";

async function main() {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`classifier: ${msg}\n`);
    process.exit(err instanceof ConfigError ? 2 : 1);
  }

  const db = createDb(cfg.databaseUrl);
  const client = createOpenRouterClient({
    apiKey: cfg.openRouterApiKey,
    timeoutMs: 8_000,
    ...(cfg.referer ? { referer: cfg.referer } : {}),
    ...(cfg.title ? { title: cfg.title } : {}),
  });

  log.info("classifier.start", {
    model: cfg.model,
    poll_ms: cfg.pollIntervalMs,
    batch: cfg.batchSize,
    one_shot: cfg.oneShot,
  });

  if (cfg.oneShot) {
    try {
      await runOnce({
        db,
        client,
        model: cfg.model,
        batchSize: cfg.batchSize,
      });
    } finally {
      await db.close();
    }
    return;
  }

  const ac = new AbortController();
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("classifier.signal", { signal });
    ac.abort();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  try {
    await runForever({
      db,
      client,
      model: cfg.model,
      batchSize: cfg.batchSize,
      pollIntervalMs: cfg.pollIntervalMs,
      stopSignal: ac.signal,
    });
  } finally {
    await db.close();
    log.info("classifier.stopped");
  }
}

main().catch((err) => {
  log.error("classifier.fatal", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
