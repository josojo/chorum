// Country breakdown — used when a question's geography dimension is a list
// of countries (continent-scoped questions) or sub-national regions
// (country-scoped questions). Renders a ranked list of pill-cards with flag
// emojis and a green/rose bar showing how each place voted yes vs no.

import { countryFlag } from "@/lib/flags";
import { COUNTRY_NAMES } from "@/lib/geo-data";
import { YesNoBar, YesNoCount } from "./yes-no-bar";

export type CountryDatum = {
  code: string;
  yes: number;
  no: number;
};

export type CountryBreakdownProps = {
  data: CountryDatum[];
  total: number;
  /** "country" renders flag emojis; "region" treats codes as opaque labels. */
  variant?: "country" | "region";
};

function labelFor(code: string, variant: "country" | "region"): string {
  if (variant === "country") {
    return COUNTRY_NAMES[code] ?? code;
  }
  return code;
}

export function CountryBreakdown({
  data,
  total,
  variant = "country",
}: CountryBreakdownProps) {
  const sorted = [...data].sort((a, b) => b.yes + b.no - (a.yes + a.no));
  const max = sorted.reduce((m, e) => (e.yes + e.no > m ? e.yes + e.no : m), 0);
  const cohortSum = sorted.reduce((s, e) => s + e.yes + e.no, 0);
  const denom = total > 0 ? total : cohortSum;

  if (sorted.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-white/50 p-4 text-sm text-slate-500">
        No location data disclosed yet.
      </div>
    );
  }

  return (
    <ol className="space-y-2">
      {sorted.map((e, i) => {
        const count = e.yes + e.no;
        const widthPct = max === 0 ? 0 : (count / max) * 100;
        const sharePct = denom === 0 ? 0 : (count / denom) * 100;
        return (
          <li
            key={e.code}
            className="group relative overflow-hidden rounded-xl border border-slate-200 bg-white p-3 shadow-sm transition hover:border-violet-300 hover:shadow"
          >
            <div className="relative flex items-center gap-3 text-sm">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[11px] font-semibold tabular-nums text-slate-600">
                {i + 1}
              </span>
              {variant === "country" ? (
                <span className="text-lg leading-none" aria-hidden>
                  {countryFlag(e.code)}
                </span>
              ) : null}
              <span className="w-20 shrink-0 truncate font-medium text-slate-800 sm:w-32">
                {labelFor(e.code, variant)}
              </span>
              <div className="min-w-0 flex-1">
                <YesNoBar yes={e.yes} no={e.no} widthPct={widthPct} />
              </div>
              <span className="w-24 shrink-0 text-right text-xs text-slate-700 sm:w-40">
                <YesNoCount yes={e.yes} no={e.no} />
                <span className="ml-1.5 hidden text-slate-500 tabular-nums sm:inline">
                  {sharePct.toFixed(0)}%
                </span>
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
