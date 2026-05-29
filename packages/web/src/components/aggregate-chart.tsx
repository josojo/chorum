// Tiny horizontal bar list rendering aggregates.by_predicate.
//
// Schema (ARCHITECTURE.md §3): `by_predicate JSONB`, one tally per
// (predicate, value) pair. Each tally is a per-option count map; yes/no is
// the 2-option case, e.g.
//   { "region:EU": {"yes": 30, "no": 12}, "age_band:25-34": {"yes": 20, "no": 10} }
// and N-option polls share the same shape with arbitrary labels:
//   { "region:EU": {"pizza": 22, "pasta": 14, "sushi": 9}, ... }
//
// We group entries by the predicate key (before the ':') so the user sees
// a section per dimension. Within a section each value is a bar sized to the
// section's max, split across the question's option list.

import {
  OptionsBar,
  OptionsCount,
  type OptionTally,
  isTally,
  tallyTotal,
} from "./options-bar";

export { isTally, tallyTotal, type OptionTally as PredicateTally };
export type ByPredicate = Record<string, OptionTally>;

export type AggregateChartProps = {
  total: number;
  byPredicate: ByPredicate;
  options: readonly string[];
};

type GroupedEntry = { value: string; tally: OptionTally };
type Grouped = Record<string, GroupedEntry[]>;

export function groupByDimension(byPredicate: ByPredicate): Grouped {
  const out: Grouped = {};
  for (const [k, raw] of Object.entries(byPredicate)) {
    if (!isTally(raw)) continue;
    // Keys look like "dimension:value"; if no ':' is present treat the whole
    // key as the value under a dimension called "other".
    const idx = k.indexOf(":");
    const dim = idx === -1 ? "other" : k.slice(0, idx);
    const value = idx === -1 ? k : k.slice(idx + 1);
    if (!out[dim]) out[dim] = [];
    out[dim].push({ value, tally: raw });
  }
  for (const dim of Object.keys(out)) {
    out[dim].sort((a, b) => tallyTotal(b.tally) - tallyTotal(a.tally));
  }
  return out;
}

export function AggregateChart({ total, byPredicate, options }: AggregateChartProps) {
  const grouped = groupByDimension(byPredicate);
  const dims = Object.keys(grouped).sort();

  if (dims.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-white/50 p-4 text-sm text-slate-500">
        No predicate data disclosed yet.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {dims.map((dim) => {
        const entries = grouped[dim];
        const sectionMax = entries.reduce(
          (m, e) => Math.max(m, tallyTotal(e.tally)),
          0,
        );
        const sectionSum = entries.reduce(
          (s, e) => s + tallyTotal(e.tally),
          0,
        );
        const denom = total > 0 ? total : sectionSum;
        return (
          <div key={dim}>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
              {dim.replace(/_/g, " ")}
            </h3>
            <ul className="space-y-2">
              {entries.map((e) => {
                const count = tallyTotal(e.tally);
                const pct = sectionMax === 0 ? 0 : (count / sectionMax) * 100;
                const share = denom === 0 ? 0 : (count / denom) * 100;
                return (
                  <li key={e.value} className="flex items-center gap-2 text-sm sm:gap-3">
                    <span className="w-16 shrink-0 truncate text-xs font-medium text-slate-700 sm:w-28 sm:text-sm">
                      {e.value}
                    </span>
                    <div className="min-w-0 flex-1">
                      <OptionsBar tally={e.tally} options={options} widthPct={pct} />
                    </div>
                    <span className="shrink-0 text-right text-xs text-slate-700 sm:w-40">
                      <OptionsCount tally={e.tally} options={options} />
                      <span className="ml-1.5 hidden text-slate-500 tabular-nums sm:inline">
                        {share.toFixed(0)}%
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
