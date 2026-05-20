// Country breakdown — used when a question's geography dimension is a list
// of countries (continent-scoped questions) or sub-national regions
// (country-scoped questions). Renders a ranked list of pill-cards with
// flag emojis and gradient-filled bars, instead of a plain bar list.

import { countryFlag } from "@/lib/flags";
import { COUNTRY_NAMES } from "@/lib/geo-data";

export type CountryDatum = {
  code: string;
  count: number;
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
  const sorted = [...data].sort((a, b) => b.count - a.count);
  const max = sorted.reduce((m, e) => (e.count > m ? e.count : m), 0);
  const cohortSum = sorted.reduce((s, e) => s + e.count, 0);
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
        const widthPct = max === 0 ? 0 : (e.count / max) * 100;
        const sharePct = denom === 0 ? 0 : (e.count / denom) * 100;
        return (
          <li
            key={e.code}
            className="group relative overflow-hidden rounded-xl border border-slate-200 bg-white p-3 shadow-sm transition hover:border-violet-300 hover:shadow"
          >
            <div
              aria-hidden
              className="absolute inset-y-0 left-0 rounded-r-xl bg-gradient-to-r from-violet-100 via-fuchsia-100 to-rose-100 opacity-70 transition group-hover:opacity-90"
              style={{ width: `${widthPct}%` }}
            />
            <div className="relative flex items-center gap-3 text-sm">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[11px] font-semibold tabular-nums text-slate-600">
                {i + 1}
              </span>
              {variant === "country" ? (
                <span className="text-lg leading-none" aria-hidden>
                  {countryFlag(e.code)}
                </span>
              ) : null}
              <span className="flex-1 truncate font-medium text-slate-800">
                {labelFor(e.code, variant)}
              </span>
              <span className="tabular-nums text-slate-700">
                <span className="font-semibold text-slate-900">{e.count}</span>
                <span className="ml-2 text-xs text-slate-500">
                  {sharePct.toFixed(1)}%
                </span>
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
