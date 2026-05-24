// Site-wide stats for /stats.
//
// The web Postgres role is walled off from `registrations` and `envelopes`
// (db/init/02-roles.sql), so agent + respondent counts can only come from the
// broker, which owns those tables and exposes them as privacy-safe COUNTs at
// GET /v1/stats. We fetch that first. If the broker is unreachable we fall
// back to the web-readable subset (questions + aggregates) so the page still
// renders real numbers, with agent/respondent counts shown as unknown.

import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { aggregates, questions } from "@/db/schema";

const BROKER_URL = process.env.BROKER_URL ?? "http://localhost:8000";

export type PlatformStats = {
  // null = not available (broker unreachable; these aren't web-readable).
  registeredAgents: number | null;
  questions: number;
  totalAnswers: number;
  respondents: number | null;
  answeredQuestions: number | null;
  avgAnswersPerQuestion: number;
  // Whether the live broker answered. false => degraded fallback view.
  brokerOnline: boolean;
};

export async function fetchPlatformStats(): Promise<PlatformStats> {
  try {
    const res = await fetch(`${BROKER_URL}/v1/stats`, {
      // Revalidate alongside the page so we don't hammer the broker.
      next: { revalidate: 30 },
    });
    if (res.ok) {
      const j = (await res.json()) as {
        registered_agents: number;
        questions: number;
        total_answers: number;
        respondents: number;
        answered_questions: number;
        avg_answers_per_question: number;
      };
      return {
        registeredAgents: j.registered_agents,
        questions: j.questions,
        totalAnswers: j.total_answers,
        respondents: j.respondents,
        answeredQuestions: j.answered_questions,
        avgAnswersPerQuestion: j.avg_answers_per_question,
        brokerOnline: true,
      };
    }
  } catch {
    // fall through to the DB-only view
  }
  return fallbackFromDb();
}

// Degraded view: only the tables the web role may read. Agent/respondent
// counts are broker-private, so they're reported as unknown (null).
async function fallbackFromDb(): Promise<PlatformStats> {
  const [[qRow], [aRow]] = await Promise.all([
    db.select({ n: sql<number>`COUNT(*)::int` }).from(questions),
    db
      .select({
        total: sql<number>`COALESCE(SUM(${aggregates.totalAnswers}), 0)::int`,
        answered: sql<number>`COUNT(*) FILTER (WHERE ${aggregates.totalAnswers} > 0)::int`,
      })
      .from(aggregates),
  ]);

  const questionCount = Number(qRow?.n ?? 0);
  const totalAnswers = Number(aRow?.total ?? 0);
  return {
    registeredAgents: null,
    questions: questionCount,
    totalAnswers,
    respondents: null,
    answeredQuestions: Number(aRow?.answered ?? 0),
    avgAnswersPerQuestion: questionCount ? totalAnswers / questionCount : 0,
    brokerOnline: false,
  };
}
