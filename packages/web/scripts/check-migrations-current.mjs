#!/usr/bin/env node
// Verifies the committed SQL migrations are in sync with schema.ts — i.e. that
// nobody edited schema.ts without running `npm run db:generate`.
//
// schema.ts is the single source of truth; drizzle-kit generate diffs it
// against the last snapshot in drizzle/migrations/meta and writes a new
// migration only if they differ. So: snapshot the migrations dir, run generate,
// and if anything changed the migrations are stale → fail. Restores the exact
// pre-run bytes afterward (git-independent), so it's safe to run locally even
// with uncommitted work.
//
// Run by .github/workflows/ci.yml (web job) and via `npm run db:check`.

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..");
const MIGRATIONS_DIR = join(WEB_DIR, "drizzle", "migrations");

// Map of relative-path -> file contents for every file under the dir.
function snapshot(dir) {
  const out = new Map();
  function walk(d) {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else out.set(relative(dir, p), readFileSync(p));
    }
  }
  walk(dir);
  return out;
}

function diff(before, after) {
  const changed = [];
  for (const [p, buf] of after) {
    if (!before.has(p)) changed.push(`+ ${p} (new)`);
    else if (!before.get(p).equals(buf)) changed.push(`~ ${p} (modified)`);
  }
  for (const p of before.keys()) if (!after.has(p)) changed.push(`- ${p} (removed)`);
  return changed;
}

function restore(before, after) {
  for (const p of after.keys()) {
    if (!before.has(p)) rmSync(join(MIGRATIONS_DIR, p), { force: true });
  }
  for (const [p, buf] of before) {
    mkdirSync(dirname(join(MIGRATIONS_DIR, p)), { recursive: true });
    writeFileSync(join(MIGRATIONS_DIR, p), buf);
  }
}

const before = snapshot(MIGRATIONS_DIR);

const gen = spawnSync(
  join(WEB_DIR, "node_modules", ".bin", "drizzle-kit"),
  ["generate", "--name", "ci_sync_check"],
  { cwd: WEB_DIR, encoding: "utf8" },
);
if (gen.status !== 0) {
  console.error(gen.stdout, gen.stderr);
  console.error("[db:check] drizzle-kit generate failed");
  process.exit(2);
}

const after = snapshot(MIGRATIONS_DIR);
const changes = diff(before, after);
restore(before, after); // always leave the tree exactly as we found it

if (changes.length > 0) {
  console.error(
    "SCHEMA OUT OF SYNC: schema.ts has changes that aren't in the committed\n" +
      "migrations. Run `npm run db:generate` and commit the result.\n\n" +
      changes.join("\n"),
  );
  process.exit(1);
}

console.log("OK: committed migrations are in sync with schema.ts.");
