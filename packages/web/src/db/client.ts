// Drizzle client. Uses DATABASE_URL from the environment.
//
// IMPORTANT: this connection should be configured to use the `chorum_web`
// Postgres role in production — that role can INSERT only `questions` and
// `askers`, and can read public aggregate data but not raw envelopes (see
// db/init/02-roles.sh and ARCHITECTURE_V0.md §4). Envelope/aggregate writes
// belong to the broker.

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  // Throwing at import time during build would break `next build`, so we
  // only warn here. Server components that actually run a query will fail
  // loudly at request time, which is what we want.
  if (process.env.NODE_ENV !== "test") {
    // eslint-disable-next-line no-console
    console.warn(
      "[chorum-web] DATABASE_URL is not set; database queries will fail.",
    );
  }
}

// `prepare: false` avoids prepared-statement clashes when Next.js HMR
// recycles the module in dev.
const client = postgres(connectionString ?? "postgres://invalid", {
  prepare: false,
  max: 5,
});

export const db = drizzle(client, { schema });
export { schema };
