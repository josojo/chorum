// GET /v1/questions/open — agents poll here.
//
// Returns rows where status='open' AND closes_at > now() and, if `since` is
// provided, created_at >= since. Each row carries created_at (the server-side
// cursor source) plus the per-question nonce the agent binds into its signature.

import type { FastifyInstance } from "fastify";

import { getDb } from "../db";
import * as q from "../queries";
import type { Question } from "../models";

// Parse a `since` query value. Returns a Date, or null when the value is
// malformed (caller returns 400). A value without a timezone is treated as UTC.
function parseSince(raw: string): Date | null {
  const v = raw.trim();
  const hasTz = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(v);
  const d = new Date(hasTz ? v : `${v}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function registerQuestionsRoutes(app: FastifyInstance): void {
  app.get("/v1/questions/open", async (req, reply) => {
    const sinceRaw = (req.query as { since?: string } | undefined)?.since;
    let since: Date | null = null;
    if (sinceRaw !== undefined) {
      since = parseSince(sinceRaw);
      if (since === null) {
        return reply.code(400).send({ error: `invalid 'since' value: ${sinceRaw}` });
      }
    }
    const rows = await q.listOpenQuestions(getDb(), since);
    const out: Question[] = rows.map((r) => ({
      question_id: r.id,
      text: r.text,
      topic: r.topic,
      options: r.options,
      created_at: r.createdAt.toISOString(),
      closes_at: r.closesAt.toISOString(),
      nonce: r.nonce,
    }));
    return out;
  });
}
