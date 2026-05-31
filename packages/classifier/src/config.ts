// Env-driven configuration. Centralised so `index.ts` is a thin entrypoint
// and so tests can build an equivalent shape by hand without touching env.

export type Config = {
  databaseUrl: string;
  openRouterApiKey: string;
  model: string;
  pollIntervalMs: number;
  batchSize: number;
  // When true, the entrypoint exits 0 immediately after one tick. Useful for
  // smoke tests / one-shot cron-style backfills.
  oneShot: boolean;
  // OpenRouter analytics headers (optional, public).
  referer: string | undefined;
  title: string | undefined;
};

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = required(env, "HEARME_CLASSIFIER_DATABASE_URL");
  const openRouterApiKey = required(env, "HEARME_CLASSIFIER_OPENROUTER_API_KEY");
  const model = env.HEARME_CLASSIFIER_MODEL || "google/gemini-2.5-flash-lite";
  const pollIntervalMs = positiveInt(
    env,
    "HEARME_CLASSIFIER_POLL_INTERVAL_MS",
    10_000,
  );
  const batchSize = positiveInt(env, "HEARME_CLASSIFIER_BATCH_SIZE", 20);
  const oneShot = (env.HEARME_CLASSIFIER_ONE_SHOT || "").toLowerCase() === "1";
  return {
    databaseUrl,
    openRouterApiKey,
    model,
    pollIntervalMs,
    batchSize,
    oneShot,
    referer: env.HEARME_CLASSIFIER_REFERER,
    title: env.HEARME_CLASSIFIER_TITLE,
  };
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v || !v.trim()) {
    throw new ConfigError(`missing required env: ${key}`);
  }
  return v.trim();
}

function positiveInt(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new ConfigError(`${key} must be a positive integer (got "${raw}")`);
  }
  return n;
}
