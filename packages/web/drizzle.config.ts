import type { Config } from "drizzle-kit";

export default {
  schema: "./src/db/schema.ts",
  // schema.ts is the single source of truth; drizzle-kit generate writes the
  // SQL migrations (baseline + deltas) and meta journal here. Never hand-edit
  // the generated SQL — change schema.ts and run `npm run db:generate`.
  out: "./drizzle/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgres://hearme_web:hearme_web_dev@localhost:5432/hearme",
  },
} satisfies Config;
