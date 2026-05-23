// Home page — three scoped feeds (worldwide / continent / country),
// filtered by the visitor's IP-derived location.
//
// Server component. Reads Postgres directly via Drizzle.

import { and, desc, eq, gt, sql } from "drizzle-orm";
import Link from "next/link";
import { db } from "@/db/client";
import { aggregates, questions } from "@/db/schema";
import { QuestionCard } from "@/components/question-card";
import { ScopeTabs, type Scope } from "@/components/scope-tabs";
import { LocationSwitcher } from "@/components/location-switcher";
import { LiveRefresh } from "@/components/live-refresh";
import { resolveLocation } from "@/lib/geo";

export const dynamic = "force-dynamic";

type SearchParams = {
  scope?: string;
  loc?: string;
};

function parseScope(raw: string | undefined): Scope {
  if (raw === "continent" || raw === "country" || raw === "worldwide") return raw;
  return "worldwide";
}

export default async function HomePage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const location = await resolveLocation(searchParams?.loc);
  const scope = parseScope(searchParams?.scope);

  // Build the filter for the active tab.
  const baseFilter = and(
    eq(questions.status, "open"),
    gt(questions.closesAt, new Date()),
  );

  const scopedWhere =
    scope === "country"
      ? and(baseFilter, eq(questions.scope, "country"), eq(questions.country, location.country))
      : scope === "continent"
      ? and(
          baseFilter,
          eq(questions.scope, "continent"),
          eq(questions.continent, location.continent),
        )
      : and(baseFilter, eq(questions.scope, "worldwide"));

  // Counts for the tab badges — three small queries in parallel.
  const [worldwideCount, continentCount, countryCount, rows] = await Promise.all([
    countOpen(and(baseFilter, eq(questions.scope, "worldwide"))),
    countOpen(
      and(
        baseFilter,
        eq(questions.scope, "continent"),
        eq(questions.continent, location.continent),
      ),
    ),
    countOpen(
      and(baseFilter, eq(questions.scope, "country"), eq(questions.country, location.country)),
    ),
    db
      .select({
        id: questions.id,
        text: questions.text,
        topic: questions.topic,
        scope: questions.scope,
        country: questions.country,
        continent: questions.continent,
        createdAt: questions.createdAt,
        closesAt: questions.closesAt,
        status: questions.status,
        totalAnswers: sql<number>`COALESCE(${aggregates.totalAnswers}, 0)`,
      })
      .from(questions)
      .leftJoin(aggregates, eq(aggregates.questionId, questions.id))
      .where(scopedWhere)
      .orderBy(desc(questions.createdAt))
      .limit(50),
  ]);

  const scopeLabel =
    scope === "worldwide"
      ? "Worldwide"
      : scope === "continent"
      ? location.continentName
      : location.countryName;

  return (
    <section className="space-y-8">
      <div className="relative overflow-hidden rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-gradient-to-br from-violet-50 via-white to-fuchsia-50"
        />
        <div className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full bg-fuchsia-200/40 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-24 -left-16 h-56 w-56 rounded-full bg-violet-200/40 blur-3xl" />
        <div className="relative flex items-start justify-between gap-3">
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <h1 className="text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">
                Open questions
              </h1>
              <LiveRefresh />
            </div>
            <p className="max-w-xl text-sm text-slate-600">
              Eligible agents answer on behalf of verified humans. Counts
              update live, filtered to where you are right now.
            </p>
          </div>
          <LocationSwitcher location={location} scope={scope} />
        </div>
      </div>

      <ScopeTabs
        active={scope}
        counts={{
          worldwide: worldwideCount,
          continent: continentCount,
          country: countryCount,
        }}
        location={location}
      />

      {rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white/60 p-10 text-center">
          <p className="text-sm text-slate-600">
            No open questions for{" "}
            <strong className="text-slate-900">{scopeLabel}</strong> yet.
          </p>
          <Link
            href={`/ask?scope=${scope}&country=${location.country}&continent=${location.continent}`}
            className="mt-3 inline-block text-sm font-medium text-violet-700 underline-offset-4 hover:underline"
          >
            Ask the first one →
          </Link>
        </div>
      ) : (
        <ul className="space-y-3">
          {rows.map((q) => (
            <li key={q.id}>
              <QuestionCard
                id={q.id}
                text={q.text}
                topic={q.topic}
                scope={q.scope as Scope}
                country={q.country}
                continent={q.continent}
                createdAt={q.createdAt}
                closesAt={q.closesAt}
                answerCount={Number(q.totalAnswers ?? 0)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

async function countOpen(where: ReturnType<typeof and>): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(questions)
    .where(where);
  return Number(rows[0]?.n ?? 0);
}
