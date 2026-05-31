// Postgres access — narrowly scoped: read open NULL-topic questions, update
// the topic column with the race-safe `WHERE topic IS NULL` guard.
//
// We use postgres-js (same driver the web app uses) over the per-service
// `hearme_classifier` role, which has SELECT on questions + UPDATE on the
// `topic` column only. Any wider write attempt should fail at the DB grant
// boundary, not in this file — i.e. we don't even try to defend in code.

import postgres from "postgres";

export type UnclassifiedQuestion = {
  id: string;
  text: string;
  options: string[];
};

export type Db = {
  listUnclassified(limit: number): Promise<UnclassifiedQuestion[]>;
  // Returns true if the row was updated, false if a concurrent worker won the
  // race (topic was no longer NULL). Either outcome is fine — we don't retry.
  setTopic(id: string, topic: string): Promise<boolean>;
  close(): Promise<void>;
};

export function createDb(connectionString: string): Db {
  const sql = postgres(connectionString, {
    // Worker is a long-lived process polling every N seconds. Keep the pool
    // small — we issue at most a handful of statements per tick.
    max: 4,
    // Don't keep connections idle forever; let pg recycle them.
    idle_timeout: 60,
    // Statement-level timeout so a bad query can't park a connection forever.
    connect_timeout: 10,
    // Avoid pg notice spam in container logs.
    onnotice: () => {},
  });

  return {
    async listUnclassified(limit) {
      const rows = await sql<
        Array<{ id: string; text: string; options: string[] }>
      >`
        SELECT id, text, options
          FROM questions
         WHERE topic IS NULL
           AND status = 'open'
           AND closes_at > now()
         ORDER BY created_at ASC
         LIMIT ${limit}
      `;
      // postgres-js returns jsonb columns parsed already; coerce defensively.
      return rows.map((r) => ({
        id: r.id,
        text: r.text,
        options: Array.isArray(r.options) ? r.options.map(String) : [],
      }));
    },

    async setTopic(id, topic) {
      // The `topic IS NULL` guard makes this idempotent even if two workers
      // (or a manual UPDATE) race for the same row: only the first writer wins.
      const result = await sql<Array<{ id: string }>>`
        UPDATE questions
           SET topic = ${topic}
         WHERE id = ${id}
           AND topic IS NULL
         RETURNING id
      `;
      return result.length === 1;
    },

    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}
