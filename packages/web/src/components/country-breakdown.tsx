// Country breakdown — used when a question's geography dimension is a list
// of countries (continent-scoped questions) or sub-national regions
// (country-scoped questions). Renders a ranked list of pill-cards with flag
// emojis and an option-split bar showing how each place voted.

import { countryFlag } from "@/lib/flags";
import { COUNTRY_NAMES } from "@/lib/geo-data";
import { OptionsBar, OptionsCount, type OptionTally, tallyTotal } from "./options-bar";

export type CountryDatum = {
  code: string;
  tally: OptionTally;
};

export type CountryBreakdownProps = {
  data: CountryDatum[];
  total: number;
  options: readonly string[];
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
  options,
  variant = "country",
}: CountryBreakdownProps) {
  const sorted = [...data].sort((a, b) => tallyTotal(b.tally) - tallyTotal(a.tally));
  const max = sorted.reduce((m, e) => Math.max(m, tallyTotal(e.tally)), 0);
  const cohortSum = sorted.reduce((s, e) => s + tallyTotal(e.tally), 0);
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
        const count = tallyTotal(e.tally);
        const widthPct = max === 0 ? 0 : (count / max) * 100;
        const sharePct = denom === 0 ? 0 : (count / denom) * 100;
        return (
          <li
            key={e.code}
            className="group relative overflow-hidden rounded-xl border border-slate-200 bg-white p-3 shadow-sm transition hover:border-violet-300 hover:shadow"
          >
            <div className="relative flex items-center gap-2 text-sm sm:gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[11px] font-semibold tabular-nums text-slate-600">
                {i + 1}
              </span>
              {variant === "country" ? (
                <span className="text-base leading-none sm:text-lg" aria-hidden>
                  {countryFlag(e.code)}
                </span>
              ) : null}
              <span className="w-16 shrink-0 truncate text-xs font-medium text-slate-800 sm:w-32 sm:text-sm">
                {labelFor(e.code, variant)}
              </span>
              <div className="min-w-0 flex-1">
                <OptionsBar tally={e.tally} options={options} widthPct={widthPct} />
              </div>
              <span className="shrink-0 text-right text-xs text-slate-700 sm:w-40">
                <OptionsCount tally={e.tally} options={options} />
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
