import { describe, it, expect } from "vitest";
import { loadConfig, ConfigError } from "../src/config.js";

function env(extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return {
    CHORUM_CLASSIFIER_DATABASE_URL: "postgres://x@y/z",
    CHORUM_CLASSIFIER_OPENROUTER_API_KEY: "sk-or-x",
    ...extra,
  } as NodeJS.ProcessEnv;
}

describe("loadConfig", () => {
  it("returns defaults when only required vars are set", () => {
    const cfg = loadConfig(env({}));
    expect(cfg.databaseUrl).toBe("postgres://x@y/z");
    expect(cfg.openRouterApiKey).toBe("sk-or-x");
    expect(cfg.model).toBe("google/gemini-2.5-flash-lite");
    expect(cfg.pollIntervalMs).toBe(10_000);
    expect(cfg.batchSize).toBe(20);
    expect(cfg.oneShot).toBe(false);
  });

  it("honours overrides", () => {
    const cfg = loadConfig(
      env({
        CHORUM_CLASSIFIER_MODEL: "google/gemini-2.5-flash",
        CHORUM_CLASSIFIER_POLL_INTERVAL_MS: "5000",
        CHORUM_CLASSIFIER_BATCH_SIZE: "5",
        CHORUM_CLASSIFIER_ONE_SHOT: "1",
      }),
    );
    expect(cfg.model).toBe("google/gemini-2.5-flash");
    expect(cfg.pollIntervalMs).toBe(5_000);
    expect(cfg.batchSize).toBe(5);
    expect(cfg.oneShot).toBe(true);
  });

  it("rejects missing required vars", () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(ConfigError);
    expect(() =>
      loadConfig({
        CHORUM_CLASSIFIER_DATABASE_URL: "postgres://x@y/z",
      } as NodeJS.ProcessEnv),
    ).toThrow(/OPENROUTER_API_KEY/);
  });

  it("rejects non-integer poll interval", () => {
    expect(() =>
      loadConfig(env({ CHORUM_CLASSIFIER_POLL_INTERVAL_MS: "abc" })),
    ).toThrow(/positive integer/);
    expect(() =>
      loadConfig(env({ CHORUM_CLASSIFIER_POLL_INTERVAL_MS: "-1" })),
    ).toThrow(/positive integer/);
  });
});
