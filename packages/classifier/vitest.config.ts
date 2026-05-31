import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Worker is event-loop driven; tests need fake timers occasionally.
    environment: "node",
    // No globals — explicit imports keep the surface obvious.
    globals: false,
  },
});
