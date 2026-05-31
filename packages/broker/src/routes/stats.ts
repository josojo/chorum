// GET /v1/stats — public, privacy-safe site-wide counts.
//
// The web role is revoked from registrations and envelopes (the privacy
// boundary in db/init/02-roles.sh), so the broker — which owns those tables — is
// the only place agent/respondent counts can be computed. Aggregate COUNTs only.

import type { FastifyInstance } from "fastify";

import { getDb } from "../db";
import * as q from "../queries";
import type { PlatformStats } from "../models";

export function registerStatsRoutes(app: FastifyInstance): void {
  app.get("/v1/stats", async () => {
    const row = await q.platformStats(getDb());
    const avg = row.questions ? row.totalAnswers / row.questions : 0.0;
    const stats: PlatformStats = {
      registered_agents: row.registeredAgents,
      questions: row.questions,
      total_answers: row.totalAnswers,
      respondents: row.respondents,
      answered_questions: row.answeredQuestions,
      avg_answers_per_question: Math.round(avg * 100) / 100,
    };
    return stats;
  });
}
