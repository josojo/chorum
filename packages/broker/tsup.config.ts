import { defineConfig } from "tsup";

// Bundle the broker into a self-contained dist/. The Drizzle schema is reused
// from packages/web/src/db/schema.ts via a relative import in src/schema.ts;
// esbuild inlines that source into the bundle. Runtime deps (fastify, drizzle,
// postgres, tweetnacl) stay external and resolve from the hoisted node_modules.
export default defineConfig({
  entry: ["src/server.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  sourcemap: true,
  // Keep node_modules external; only our own source (incl. the reused schema) is bundled.
  skipNodeModulesBundle: true,
});
