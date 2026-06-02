// Picks the "featured" question for the home hero: the most-answered question
// that is still open. Turns its public aggregate (`aggregates.by_predicate`)
// into the shapes the WorldMap wants, plus an overall option tally for the
// live-result bars.
//
// Server-only (reads Postgres). Returns null when no open question has any
// answers yet — the hero then renders its zero-data state. Like everywhere
// else in the app, only aggregates are read; raw envelopes stay broker-private.

import { and, desc, eq, gt } from "drizzle-orm";
import { db } from "@/db/client";
import { aggregates, questions } from "@/db/schema";
import { COUNTRY_TO_CONTINENT, type Continent } from "@/lib/geo-data";
import type { ContinentDatum } from "@/components/world-map";
import type { OptionTally } from "@/components/options-bar";

const KNOWN_CONTINENTS: ReadonlyArray<Continent> = [
  "AF",
  "AN",
  "AS",
  "EU",
  "NA",
  "OC",
  "SA",
];

export type FeaturedQuestion = {
  id: string;
  text: string;
  options: string[];
  totalAnswers: number;
  continentData: ContinentDatum[];
  countryData: Array<{ code: string; tally: OptionTally }>;
  // Overall option counts, summed across the geo partition (continents, or
  // countries when no continent buckets exist). Empty when geo data is absent.
  tally: OptionTally;
};

function isTally(v: unknown): v is OptionTally {
  if (typeof v !== "object" || v === null) return false;
  for (const n of Object.values(v as Record<string, unknown>)) {
    if (typeof n !== "number" || !Number.isFinite(n)) return false;
  }
  return true;
}

function addInto(target: OptionTally, src: OptionTally) {
  for (const [k, n] of Object.entries(src)) target[k] = (target[k] ?? 0) + n;
}

export async function fetchFeaturedQuestion(): Promise<FeaturedQuestion | null> {
  const rows = await db
    .select({
      id: questions.id,
      text: questions.text,
      options: questions.options,
      totalAnswers: aggregates.totalAnswers,
      byPredicate: aggregates.byPredicate,
    })
    .from(questions)
    .innerJoin(aggregates, eq(aggregates.questionId, questions.id))
    .where(
      and(
        eq(questions.status, "open"),
        gt(questions.closesAt, new Date()),
        gt(aggregates.totalAnswers, 0),
      ),
    )
    .orderBy(desc(aggregates.totalAnswers))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const options: string[] = Array.isArray(row.options)
    ? (row.options as unknown[]).map(String).filter((o) => o.length > 0)
    : ["yes", "no"];

  const byPredicate = (row.byPredicate ?? {}) as Record<string, unknown>;
  const continentData: ContinentDatum[] = [];
  const countryData: Array<{ code: string; tally: OptionTally }> = [];
  const continentTally: OptionTally = {};
  const countryOnlyTally: OptionTally = {};

  for (const [key, raw] of Object.entries(byPredicate)) {
    if (!isTally(raw)) continue;
    const idx = key.indexOf(":");
    if (idx === -1) continue;
    const dim = key.slice(0, idx);
    const value = key.slice(idx + 1);

    if (dim === "continent" || dim === "region") {
      // `region` carries continent codes at worldwide scope (sub-national
      // labels at country scope, which we skip for the world map).
      if (KNOWN_CONTINENTS.includes(value as Continent)) {
        continentData.push({ code: value as Continent, tally: raw });
        addInto(continentTally, raw);
      }
    } else if (dim === "country") {
      countryData.push({ code: value, tally: raw });
      // Roll countries up into a continent fallback when no continent buckets.
      const cont = COUNTRY_TO_CONTINENT[value] as Continent | undefined;
      if (cont) addInto(countryOnlyTally, raw);
    }
  }

  const tally =
    Object.keys(continentTally).length > 0 ? continentTally : countryOnlyTally;

  return {
    id: row.id,
    text: row.text,
    options: options.length >= 2 ? options : ["yes", "no"],
    totalAnswers: row.totalAnswers ?? 0,
    continentData,
    countryData,
    tally,
  };
}
