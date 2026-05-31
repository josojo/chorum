// End-to-end check that scripts/migrate.mjs upgrades a "staging-shaped" DB
// (volume that already has the baseline applied) without losing data and is
// idempotent on re-run.
//
// We exercise the migrator MECHANISM with a self-contained fixture migration
// set (pointed at via HEARME_MIGRATIONS_DIR) rather than the real generated
// migrations, so the test stays meaningful no matter how many real deltas
// exist — including zero, right after a baseline regeneration. The fixture
// baseline creates a `questions` table (the sentinel migrate.mjs uses to
// detect an already-bootstrapped volume) plus a delta that adds a column +
// CHECK, mirroring a real schema change.
//
// Strategy: spin up postgres:16 via `docker run`, apply the fixture baseline by
// hand (simulating what initdb did when the staging volume was first created),
// insert one row, then invoke the migrator twice and assert the new column /
// CHECK constraint / preserved row / `_schema_migrations` ledger.
//
// Skipped if `docker` is not available (e.g. CI without Docker-in-Docker).
// Single test, ~60s budget.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import postgres from "postgres";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const MIGRATE_SCRIPT = join(REPO_ROOT, "packages/web/scripts/migrate.mjs");

// Self-contained fixture migrations. 0000_init creates the `questions` sentinel
// table; 0001 is the delta the migrator should apply on top.
const FIXTURE_BASELINE = `CREATE TABLE questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  text text NOT NULL,
  closes_at timestamptz NOT NULL
);`;
const FIXTURE_DELTA = `ALTER TABLE questions ADD COLUMN IF NOT EXISTS color text NOT NULL DEFAULT 'blue';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'questions_color_chk' AND conrelid = 'questions'::regclass
  ) THEN
    ALTER TABLE questions
      ADD CONSTRAINT questions_color_chk CHECK (color IN ('blue','red','green'));
  END IF;
END $$;`;
let migrationsDir = "";

function dockerAvailable(): boolean {
  const r = spawnSync("docker", ["info"], { stdio: "ignore" });
  return r.status === 0;
}

function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("no port")));
      }
    });
    srv.on("error", reject);
  });
}

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  let lastErr: unknown = null;
  while (Date.now() - start < timeoutMs) {
    try {
      if (await fn()) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out after ${timeoutMs}ms: ${lastErr}`);
}

const skipSuite = !dockerAvailable();

(skipSuite ? describe.skip : describe)(
  "migrate.mjs against a real Postgres",
  () => {
    let containerName = "";
    let dsn = "";

    beforeAll(async () => {
      // Write the fixture migration set to a temp dir.
      migrationsDir = mkdtempSync(join(tmpdir(), "hearme-migtest-"));
      writeFileSync(join(migrationsDir, "0000_init.sql"), FIXTURE_BASELINE);
      writeFileSync(join(migrationsDir, "0001_add_color.sql"), FIXTURE_DELTA);

      const port = await pickFreePort();
      containerName = `hearme-migtest-${process.pid}-${Date.now()}`;
      execSync(
        `docker run -d --rm --name ${containerName} ` +
          `-e POSTGRES_PASSWORD=t -e POSTGRES_DB=hearme ` +
          `-p ${port}:5432 postgres:16`,
        { stdio: "ignore" },
      );
      dsn = `postgres://postgres:t@127.0.0.1:${port}/hearme`;

      // Wait until Postgres is accepting connections.
      const probe = postgres(dsn, { max: 1, onnotice: () => {} });
      try {
        await waitFor(async () => {
          try {
            await probe`SELECT 1`;
            return true;
          } catch {
            return false;
          }
        });
      } finally {
        await probe.end({ timeout: 5 });
      }

      // Bootstrap the fixture BASELINE (what initdb would have applied on the
      // first boot of an existing staging volume).
      const sql = postgres(dsn, { max: 1, onnotice: () => {} });
      try {
        await sql.unsafe(FIXTURE_BASELINE);
        // One pre-existing row — proves the ALTER preserves data.
        await sql`
          INSERT INTO questions(text, closes_at)
          VALUES ('Pre-existing question?', now() + interval '1 day')
        `;
      } finally {
        await sql.end({ timeout: 5 });
      }
    }, 60_000);

    afterAll(() => {
      if (containerName) {
        spawnSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
      }
      if (migrationsDir) rmSync(migrationsDir, { recursive: true, force: true });
    });

    function runMigrator(): { status: number; stdout: string; stderr: string } {
      const r = spawnSync("node", [MIGRATE_SCRIPT], {
        env: {
          ...process.env,
          MIGRATOR_DATABASE_URL: dsn,
          HEARME_MIGRATIONS_DIR: migrationsDir,
        },
        encoding: "utf8",
      });
      return {
        status: r.status ?? -1,
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
      };
    }

    it("applies the delta to a staging-shaped DB, preserves data, is idempotent", async () => {
      // Pre-migration: confirm the baseline really lacks the new column,
      // so the test would actually fail if the migrator didn't do its job.
      const probe = postgres(dsn, { max: 1, onnotice: () => {} });
      try {
        const cols0 = await probe`
          SELECT column_name FROM information_schema.columns
          WHERE table_name = 'questions' AND column_name = 'color'
        `;
        expect(cols0).toHaveLength(0);
      } finally {
        await probe.end({ timeout: 5 });
      }

      // First migrator run: baselines 0000_init, applies the delta.
      const first = runMigrator();
      expect(
        first.status,
        `first run failed:\n${first.stdout}\n${first.stderr}`,
      ).toBe(0);
      expect(first.stdout).toMatch(/baselining 0000_init/);
      expect(first.stdout).toMatch(/applying 0001_add_color/);

      // Verify the column, default, CHECK, and preserved row.
      const sql = postgres(dsn, { max: 1, onnotice: () => {} });
      try {
        const cols = await sql`
          SELECT column_name, data_type, is_nullable
          FROM information_schema.columns
          WHERE table_name = 'questions' AND column_name = 'color'
        `;
        expect(cols).toHaveLength(1);
        expect(cols[0].data_type).toBe("text");
        expect(cols[0].is_nullable).toBe("NO");

        // Pre-existing row picked up the column default.
        const [row] = await sql`
          SELECT color FROM questions WHERE text = 'Pre-existing question?'
        `;
        expect(row.color).toBe("blue");

        // CHECK constraint: an out-of-range value is rejected.
        await expect(
          sql`
            INSERT INTO questions(text, closes_at, color)
            VALUES ('bad', now() + interval '1 day', 'purple')
          `,
        ).rejects.toThrow(/questions_color_chk/);

        // An allowed value succeeds.
        await sql`
          INSERT INTO questions(text, closes_at, color)
          VALUES ('ok', now() + interval '1 day', 'green')
        `;

        // Ledger: both versions recorded.
        const versions = await sql`
          SELECT version FROM _schema_migrations ORDER BY version
        `;
        expect(versions.map((r) => r.version)).toEqual([
          "0000_init",
          "0001_add_color",
        ]);
      } finally {
        await sql.end({ timeout: 5 });
      }

      // Second run: no-op. No new versions recorded, no errors.
      const second = runMigrator();
      expect(
        second.status,
        `second run failed:\n${second.stdout}\n${second.stderr}`,
      ).toBe(0);
      expect(second.stdout).not.toMatch(/applying /);
      expect(second.stdout).toMatch(/done \(0 applied/);

      const sql2 = postgres(dsn, { max: 1, onnotice: () => {} });
      try {
        const [{ count }] = await sql2`
          SELECT COUNT(*)::int AS count FROM _schema_migrations
        `;
        expect(count).toBe(2);
      } finally {
        await sql2.end({ timeout: 5 });
      }
    }, 60_000);
  },
);
