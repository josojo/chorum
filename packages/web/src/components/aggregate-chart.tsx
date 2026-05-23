// Tiny horizontal bar list rendering aggregates.by_predicate.
//
// Schema (ARCHITECTURE.md §3): `by_predicate JSONB`, one yes/no tally per
// (predicate, value) pair, e.g.
//   { "region:EU": {"yes": 30, "no": 12}, "age_band:25-34": {"yes": 20, "no": 10} }
//
// We group entries by the predicate key (before the ':') so the user sees
// a section per dimension. Within a section each value is a bar sized to the
// section's max, split green/rose by how that cohort voted.

import { YesNoBar, YesNoCount } from "./yes-no-bar";

/** One bucket's vote split. `count` is derived as `yes + no`. */
export type PredicateTally = { yes: number; no: number };
export type ByPredicate = Record<string, PredicateTally>;

export type AggregateChartProps = {
  total: number;
  byPredicate: ByPredicate;
};

export function tallyTotal(t: PredicateTally | undefined | null): number {
  return (t?.yes ?? 0) + (t?.no ?? 0);
}

export function isTally(v: unknown): v is PredicateTally {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as PredicateTally).yes === "number" &&
    Number.isFinite((v as PredicateTally).yes) &&
    typeof (v as PredicateTally).no === "number" &&
    Number.isFinite((v as PredicateTally).no)
  );
}

type GroupedEntry = { value: string; yes: number; no: number };
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
    out[dim].push({ value, yes: raw.yes, no: raw.no });
  }
  for (const dim of Object.keys(out)) {
    out[dim].sort((a, b) => b.yes + b.no - (a.yes + a.no));
  }
  return out;
}

export function AggregateChart({ total, byPredicate }: AggregateChartProps) {
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
          (m, e) => (e.yes + e.no > m ? e.yes + e.no : m),
          0,
        );
        const sectionSum = entries.reduce((s, e) => s + e.yes + e.no, 0);
        const denom = total > 0 ? total : sectionSum;
        return (
          <div key={dim}>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
              {dim.replace(/_/g, " ")}
            </h3>
            <ul className="space-y-2">
              {entries.map((e) => {
                const count = e.yes + e.no;
                const pct = sectionMax === 0 ? 0 : (count / sectionMax) * 100;
                const share = denom === 0 ? 0 : (count / denom) * 100;
                return (
                  <li key={e.value} className="flex items-center gap-3 text-sm">
                    <span className="w-20 shrink-0 truncate font-medium text-slate-700 sm:w-28">
                      {e.value}
                    </span>
                    <div className="min-w-0 flex-1">
                      <YesNoBar yes={e.yes} no={e.no} widthPct={pct} />
                    </div>
                    <span className="w-24 shrink-0 text-right text-xs text-slate-700 sm:w-40">
                      <YesNoCount yes={e.yes} no={e.no} />
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
