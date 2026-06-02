// /q/[id] — question detail.
//
// Server component. Reads:
//   - the question row
//   - its aggregates row (total + by_predicate)
// Raw envelopes remain broker-private; the public page shows aggregates only.
//
// Per ARCHITECTURE_V0.md §4, we use Next.js `revalidate` (10s) instead of
// websockets / SSE — that's a v0.2 upgrade documented in §11.

import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { db } from "@/db/client";
import { aggregates, questions } from "@/db/schema";
import { QuestionDetail } from "@/components/question-detail";
import type { ByPredicate } from "@/components/aggregate-chart";

export const revalidate = 10;

type PageProps = {
  params: { id: string };
};

const SHARE_DESCRIPTION =
  "Live, verified answers broken down by geography and age — only the aggregate, never individual responses.";

// `questions.id` is a uuid column; binding a non-uuid path (e.g. /q/anything)
// straight into the query makes Postgres raise "invalid input syntax for type
// uuid", which would surface as a raw 500. Validate the shape first and treat a
// non-uuid id as not-found instead of letting the DB throw.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  // Never query with a non-uuid id (it would throw); fall back to the default
  // title and let the page component issue notFound().
  if (!UUID_RE.test(params.id)) return { title: "Question not found" };

  let text: string | null = null;
  try {
    const rows = await db
      .select({ text: questions.text })
      .from(questions)
      .where(eq(questions.id, params.id))
      .limit(1);
    text = rows[0]?.text ?? null;
  } catch {
    // Metadata is best-effort; never let it break the page render.
  }

  if (!text) return { title: "Question not found" };

  const title = text.length > 70 ? text.slice(0, 67) + "…" : text;
  return {
    title,
    description: SHARE_DESCRIPTION,
    openGraph: {
      type: "article",
      title,
      description: SHARE_DESCRIPTION,
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: SHARE_DESCRIPTION,
    },
  };
}

export default async function QuestionPage({ params }: PageProps) {
  // A non-uuid id can never match the uuid PK; render 404 before touching the DB
  // so a garbage path is a clean not-found instead of a uuid-cast 500.
  if (!UUID_RE.test(params.id)) {
    notFound();
  }

  const questionRows = await db
    .select()
    .from(questions)
    .where(eq(questions.id, params.id))
    .limit(1);

  if (questionRows.length === 0) {
    notFound();
  }
  const question = questionRows[0];
  const effectiveStatus =
    question.status === "open" && question.closesAt > new Date()
      ? "open"
      : "closed";

  const aggRows = await db
    .select()
    .from(aggregates)
    .where(eq(aggregates.questionId, params.id))
    .limit(1);

  const totalAnswers = aggRows[0]?.totalAnswers ?? 0;
  const byPredicate =
    (aggRows[0]?.byPredicate as ByPredicate | null) ?? ({} as ByPredicate);
  const noSignalTotal = aggRows[0]?.noSignalTotal ?? 0;
  const noSignalByPredicate =
    (aggRows[0]?.noSignalByPredicate as Record<string, number> | null) ?? {};

  // `options` is jsonb in the DB; the Drizzle type-cast keeps callers honest
  // but the row may legitimately be missing in old fixtures — fall back to
  // the legacy yes/no shape.
  const optionsRaw = (question as { options?: unknown }).options;
  const options: string[] = Array.isArray(optionsRaw)
    ? (optionsRaw as unknown[]).map(String).filter((o) => o.length > 0)
    : ["yes", "no"];

  return (
    <QuestionDetail
      question={{
        id: question.id,
        text: question.text,
        topic: question.topic,
        options: options.length >= 2 ? options : ["yes", "no"],
        status: effectiveStatus,
        scope: question.scope as "worldwide" | "continent" | "country",
        country: question.country,
        continent: question.continent,
        createdAt: question.createdAt,
        closesAt: question.closesAt,
      }}
      totalAnswers={totalAnswers}
      byPredicate={byPredicate}
      noSignalTotal={noSignalTotal}
      noSignalByPredicate={noSignalByPredicate}
    />
  );
}
