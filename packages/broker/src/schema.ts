// Re-export the Drizzle schema from packages/web — THE single source of truth
// for the shared Postgres schema (packages/web/src/db/schema.ts). The broker
// imports its table objects from here so the DB shape is defined exactly once.
//
// The relative import resolves at typecheck (tsc), test (vitest), and build
// (tsup/esbuild inlines the source). The Docker image mirrors the monorepo
// layout (packages/broker + packages/web/src/db/schema.ts) with a hoisted
// node_modules so drizzle-orm resolves for both.
export * from "../../web/src/db/schema";
