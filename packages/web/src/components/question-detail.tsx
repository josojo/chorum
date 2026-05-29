// Pure presentational component for the question detail page.
// Split out from src/app/q/[id]/page.tsx so it's trivial to unit-test without
// touching the database.
//
// Layout: Geography always on top (a real world map when the data is
// continent-bucketed, a ranked country/region list otherwise), then Age,
// then any remaining dimensions in a generic chart.

import { AggregateChart, isTally, type ByPredicate } from "./aggregate-chart";
import { AgeChart } from "./age-chart";
import { CountryBreakdown } from "./country-breakdown";
import { WorldMap, type ContinentDatum } from "./world-map";
import { OptionsLegend, type OptionTally } from "./options-bar";
import { countryFlag } from "@/lib/flags";
import {
  CONTINENT_NAMES,
  COUNTRY_NAMES,
  COUNTRY_TO_CONTINENT,
  type Continent,
} from "@/lib/geo-data";
import { describeClose, formatAbsoluteUTC, formatRelative } from "@/lib/time";
import { ShareButton } from "./share-button";
import { LiveRefresh } from "./live-refresh";

export type QuestionDetailProps = {
  question: {
    id: string;
    text: string;
    topic: string | null;
    options: string[];
    status: string;
    scope?: "worldwide" | "continent" | "country";
    country?: string | null;
    continent?: string | null;
    createdAt: Date;
    closesAt: Date;
  };
  totalAnswers: number;
  byPredicate: ByPredicate;
};

const KNOWN_CONTINENTS: ReadonlyArray<Continent> = [
  "AF",
  "AN",
  "AS",
  "EU",
  "NA",
  "OC",
  "SA",
];

function ScopePill(props: {
  scope?: "worldwide" | "continent" | "country";
  country?: string | null;
  continent?: string | null;
}) {
  if (props.scope === "country" && props.country) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-800">
        <span aria-hidden>{countryFlag(props.country)}</span>
        {COUNTRY_NAMES[props.country] ?? props.country}
      </span>
    );
  }
  if (props.scope === "continent" && props.continent) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-fuchsia-100 px-2 py-0.5 text-xs font-medium text-fuchsia-800">
        <span aria-hidden>🗺️</span>
        {CONTINENT_NAMES[props.continent as Continent] ?? props.continent}
      </span>
    );
  }
  if (props.scope === "worldwide") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
        <span aria-hidden>🌍</span>
        Worldwide
      </span>
    );
  }
  return null;
}

/**
 * Splits `byPredicate` into geography / age / other buckets. The geography
 * bucket itself splits into "continent" (atlas-mappable codes) and "country"
 * (or sub-national region), so the renderer can pick the right widget.
 */
function partition(byPredicate: ByPredicate) {
  const geoContinent: ContinentDatum[] = [];
  const geoCountry: Array<{ code: string; tally: OptionTally }> = [];
  const geoRegion: Array<{ code: string; tally: OptionTally }> = [];
  const age: Array<{ band: string; tally: OptionTally }> = [];
  const other: ByPredicate = {};

  for (const [k, raw] of Object.entries(byPredicate)) {
    if (!isTally(raw)) continue;
    const tally = raw;
    const idx = k.indexOf(":");
    if (idx === -1) {
      other[k] = tally;
      continue;
    }
    const dim = k.slice(0, idx);
    const value = k.slice(idx + 1);
    if (dim === "age_band" || dim === "age") {
      age.push({ band: value, tally });
    } else if (dim === "country") {
      geoCountry.push({ code: value, tally });
    } else if (dim === "continent") {
      if (KNOWN_CONTINENTS.includes(value as Continent)) {
        geoContinent.push({ code: value as Continent, tally });
      } else {
        geoRegion.push({ code: value, tally });
      }
    } else if (dim === "region") {
      // `region` is overloaded: at worldwide scope it carries continent codes
      // ("EU", "NA", "AS", ...); at country scope it carries sub-national
      // labels ("northeast", "Berlin", "NSW", ...). Detect by membership.
      if (KNOWN_CONTINENTS.includes(value as Continent)) {
        geoContinent.push({ code: value as Continent, tally });
      } else {
        geoRegion.push({ code: value, tally });
      }
    } else {
      other[k] = tally;
    }
  }

  return { geoContinent, geoCountry, geoRegion, age, other };
}

/**
 * Which continent the map should open zoomed into. Prefer the question's
 * declared continent; otherwise, when the data is purely per-country (a
 * continent-scoped question), infer the continent carrying the most responses.
 */
function resolveFocus(
  question: QuestionDetailProps["question"],
  parts: ReturnType<typeof partition>,
): Continent | null {
  if (
    question.continent &&
    KNOWN_CONTINENTS.includes(question.continent as Continent)
  ) {
    return question.continent as Continent;
  }
  if (parts.geoContinent.length === 0 && parts.geoCountry.length > 0) {
    const tally = new Map<Continent, number>();
    for (const c of parts.geoCountry) {
      const cont = COUNTRY_TO_CONTINENT[c.code] as Continent | undefined;
      if (!cont) continue;
      const total = Object.values(c.tally).reduce((s, n) => s + (n ?? 0), 0);
      tally.set(cont, (tally.get(cont) ?? 0) + total);
    }
    let best: Continent | null = null;
    let bestN = -1;
    for (const [cont, n] of tally) {
      if (n > bestN) {
        bestN = n;
        best = cont;
      }
    }
    return best;
  }
  return null;
}

function CloseLabel({
  closesAt,
  status,
}: {
  closesAt: Date;
  status: string;
}) {
  const { label, urgency } = describeClose(closesAt, undefined, status);
  if (urgency === "soon") {
    return (
      <span
        title={formatAbsoluteUTC(closesAt)}
        className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-800"
      >
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" aria-hidden />
        {label}
      </span>
    );
  }
  return (
    <>
      <span className="text-slate-300" aria-hidden>·</span>
      <span title={formatAbsoluteUTC(closesAt)}>{label}</span>
    </>
  );
}

function SectionHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-slate-200 pb-2">
      <h2 className="text-lg font-semibold tracking-tight text-slate-900">
        {title}
      </h2>
      {subtitle ? (
        <span className="text-xs uppercase tracking-wider text-slate-500">
          {subtitle}
        </span>
      ) : null}
    </div>
  );
}

export function QuestionDetail(props: QuestionDetailProps) {
  const { question, totalAnswers, byPredicate } = props;
  const options = question.options;
  const parts = partition(byPredicate);

  const hasGeography =
    parts.geoContinent.length > 0 ||
    parts.geoCountry.length > 0 ||
    parts.geoRegion.length > 0;
  const hasAge = parts.age.length > 0;
  const hasOther = Object.keys(parts.other).length > 0;
  const hasAnyBreakdown = hasGeography || hasAge || hasOther;

  return (
    <article className="space-y-6 sm:space-y-8">
      <header className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:rounded-3xl sm:p-8">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-0 bg-gradient-to-br from-violet-50 via-white to-fuchsia-50"
        />
        <div className="relative">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-slate-500">
            <ScopePill
              scope={question.scope}
              country={question.country}
              continent={question.continent}
            />
            {question.topic ? (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-700">
                #{question.topic}
              </span>
            ) : null}
            <span
              className={
                "rounded-full px-2 py-0.5 font-medium " +
                (question.status === "open"
                  ? "bg-emerald-100 text-emerald-800"
                  : "bg-slate-200 text-slate-700")
              }
            >
              {question.status}
            </span>
            <span className="hidden text-slate-300 sm:inline" aria-hidden>·</span>
            <span title={formatAbsoluteUTC(question.createdAt)}>
              opened {formatRelative(question.createdAt)}
            </span>
            <CloseLabel closesAt={question.closesAt} status={question.status} />
          </div>
          <h1 className="mt-3 text-xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
            {question.text}
          </h1>
          <div className="mt-4 flex flex-wrap items-center gap-2 text-sm text-slate-600 sm:gap-3">
            <span className="inline-flex items-baseline gap-1.5 rounded-full bg-white/80 px-3 py-1 shadow-sm ring-1 ring-slate-200">
              <span className="text-base font-semibold text-slate-900 tabular-nums">
                {totalAnswers}
              </span>
              <span className="text-slate-600">
                {totalAnswers === 1 ? "verified answer" : "verified answers"}
              </span>
            </span>
            <ShareButton title={question.text} />
            {question.status === "open" ? (
              <span className="sm:ml-auto">
                <LiveRefresh />
              </span>
            ) : null}
          </div>
        </div>
      </header>

      {!hasAnyBreakdown ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white/60 p-8 text-center text-sm text-slate-600">
          No answers yet — people&apos;s agents are still responding. This page
          updates on its own as results come in.
        </div>
      ) : null}

      {hasAnyBreakdown ? (
        <div className="flex items-center justify-end">
          <OptionsLegend options={options} />
        </div>
      ) : null}

      {hasGeography ? (
        <section className="space-y-4">
          <SectionHeader
            title="Geography"
            subtitle={
              parts.geoContinent.length > 0
                ? "by continent"
                : parts.geoCountry.length > 0
                ? "by country"
                : "by region"
            }
          />
          {parts.geoContinent.length > 0 || parts.geoCountry.length > 0 ? (
            <WorldMap
              continentData={parts.geoContinent}
              countryData={parts.geoCountry}
              total={totalAnswers}
              options={options}
              focusContinent={resolveFocus(question, parts)}
            />
          ) : null}
          {parts.geoCountry.length > 0 ? (
            <CountryBreakdown
              data={parts.geoCountry}
              total={totalAnswers}
              options={options}
              variant="country"
            />
          ) : null}
          {parts.geoRegion.length > 0 ? (
            <CountryBreakdown
              data={parts.geoRegion}
              total={totalAnswers}
              options={options}
              variant="region"
            />
          ) : null}
        </section>
      ) : null}

      {hasAge ? (
        <section className="space-y-4">
          <SectionHeader title="Age" subtitle="by cohort" />
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
            <AgeChart data={parts.age} total={totalAnswers} options={options} />
          </div>
        </section>
      ) : null}

      {hasOther ? (
        <section className="space-y-4">
          <SectionHeader title="Other dimensions" />
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
            <AggregateChart
              total={totalAnswers}
              byPredicate={parts.other}
              options={options}
            />
          </div>
        </section>
      ) : null}
    </article>
  );
}
