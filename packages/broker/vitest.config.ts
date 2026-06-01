import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // DB-backed tests spin up a real Postgres via testcontainers; give them room.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
