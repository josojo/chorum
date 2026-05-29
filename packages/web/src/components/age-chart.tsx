// Age-demographics chart. Each cohort gets a bar sized to its share of the
// largest cohort, split by the question's option list, with the per-option
// counts plus the cohort's share of total responses rendered inline.

import { OptionsBar, OptionsCount, type OptionTally, tallyTotal } from "./options-bar";

export type AgeDatum = {
  band: string;
  tally: OptionTally;
};

export type AgeChartProps = {
  data: AgeDatum[];
  total: number;
  options: readonly string[];
};

// Canonical age-band ordering. Anything we don't recognise falls back to
// the end of the list in the order it came in.
const BAND_ORDER = [
  "0-17",
  "18-24",
  "25-34",
  "35-44",
  "45-54",
  "55-64",
  "55+",
  "65+",
];

function sortBands(data: AgeDatum[]): AgeDatum[] {
  const indexOf = (b: string) => {
    const i = BAND_ORDER.indexOf(b);
    return i === -1 ? 999 : i;
  };
  return [...data].sort((a, b) => indexOf(a.band) - indexOf(b.band));
}

export function AgeChart({ data, total, options }: AgeChartProps) {
  const sorted = sortBands(data);
  const max = sorted.reduce((m, e) => Math.max(m, tallyTotal(e.tally)), 0);
  const cohortSum = sorted.reduce((s, e) => s + tallyTotal(e.tally), 0);
  const denom = total > 0 ? total : cohortSum;

  if (sorted.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-white/50 p-4 text-sm text-slate-500">
        No age-band data disclosed yet.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {sorted.map((e) => {
        const count = tallyTotal(e.tally);
        const widthPct = max === 0 ? 0 : (count / max) * 100;
        const sharePct = denom === 0 ? 0 : (count / denom) * 100;
        return (
          <div key={e.band} className="space-y-1">
            <div className="flex items-baseline justify-between text-sm">
              <span className="font-medium text-slate-700">{e.band}</span>
              <span className="text-xs text-slate-500">
                <OptionsCount tally={e.tally} options={options} />
                <span className="ml-2 text-slate-500 tabular-nums">
                  {sharePct.toFixed(1)}%
                </span>
              </span>
            </div>
            <OptionsBar tally={e.tally} options={options} widthPct={widthPct} />
          </div>
        );
      })}
    </div>
  );
}
