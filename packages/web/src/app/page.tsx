// Home page.
//
// Top: the hero — "the world is thinking out loud" — a live, real-data pulse
// (site-wide answer total + the most-answered open question on the world map)
// with "Add your voice" as the primary call to action.
// Then: why it matters.
// Then: the live question feed — three scoped tabs (worldwide / continent /
// country) filtered to the visitor's IP-derived location.
//
// Server component. Reads Postgres directly via Drizzle; site-wide counts come
// from the broker (with a DB fallback) via fetchPlatformStats().

import { and, desc, eq, gt, sql } from "drizzle-orm";
import Link from "next/link";
import { db } from "@/db/client";
import { aggregates, questions } from "@/db/schema";
import { PulseHero } from "@/components/pulse-hero";
import { WhyBand } from "@/components/why-band";
import { QuestionList } from "@/components/question-list";
import { ScopeTabs, type Scope } from "@/components/scope-tabs";
import { LocationSwitcher } from "@/components/location-switcher";
import { resolveLocation } from "@/lib/geo";
import { fetchPlatformStats } from "@/lib/stats";
import { fetchFeaturedQuestion } from "@/lib/featured";

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

  // Filter for the active feed tab.
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

  const [stats, featured, worldwideCount, continentCount, countryCount, rows] =
    await Promise.all([
      fetchPlatformStats(),
      fetchFeaturedQuestion(),
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
    <div className="space-y-10 sm:space-y-14">
      <PulseHero
        voicesHeard={stats.totalAnswers}
        verifiedPeople={stats.respondents}
        questionsAsked={stats.questions}
        featured={featured}
      />

      <WhyBand />

      <section className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h2 className="text-xl font-semibold tracking-tight text-slate-900 sm:text-2xl">
              See it working — live questions
            </h2>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
              updating
            </span>
          </div>
          <LocationSwitcher location={location} scope={scope} />
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
          <QuestionList
            items={rows.map((q) => ({
              id: q.id,
              text: q.text,
              topic: q.topic,
              scope: q.scope as Scope,
              country: q.country,
              continent: q.continent,
              createdAt: q.createdAt,
              closesAt: q.closesAt,
              answerCount: Number(q.totalAnswers ?? 0),
            }))}
          />
        )}
      </section>
    </div>
  );
}

async function countOpen(where: ReturnType<typeof and>): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(questions)
    .where(where);
  return Number(rows[0]?.n ?? 0);
}
