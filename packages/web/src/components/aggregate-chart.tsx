// Tiny horizontal bar list rendering aggregates.by_predicate.
//
// Schema (ARCHITECTURE.md §3): `by_predicate JSONB`, e.g.
//   { "region:EU": 42, "region:non-EU": 18, "age_band:25-34": 30 }
//
// We group entries by the predicate key (before the ':') so the user sees
// a section per dimension. Within a section the values are bars proportional
// to the section's max.

export type ByPredicate = Record<string, number>;

export type AggregateChartProps = {
  total: number;
  byPredicate: ByPredicate;
};

type Grouped = Record<string, Array<{ value: string; count: number }>>;

export function groupByDimension(byPredicate: ByPredicate): Grouped {
  const out: Grouped = {};
  for (const [k, raw] of Object.entries(byPredicate)) {
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    // Keys look like "dimension:value"; if no ':' is present treat the whole
    // key as the value under a dimension called "other".
    const idx = k.indexOf(":");
    const dim = idx === -1 ? "other" : k.slice(0, idx);
    const value = idx === -1 ? k : k.slice(idx + 1);
    if (!out[dim]) out[dim] = [];
    out[dim].push({ value, count: raw });
  }
  for (const dim of Object.keys(out)) {
    out[dim].sort((a, b) => b.count - a.count);
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
          (m, e) => (e.count > m ? e.count : m),
          0,
        );
        const sectionSum = entries.reduce((s, e) => s + e.count, 0);
        const denom = total > 0 ? total : sectionSum;
        return (
          <div key={dim}>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
              {dim.replace(/_/g, " ")}
            </h3>
            <ul className="space-y-2">
              {entries.map((e) => {
                const pct = sectionMax === 0 ? 0 : (e.count / sectionMax) * 100;
                const share = denom === 0 ? 0 : (e.count / denom) * 100;
                return (
                  <li
                    key={e.value}
                    className="flex items-center gap-3 text-sm"
                  >
                    <span className="w-28 shrink-0 truncate font-medium text-slate-700">
                      {e.value}
                    </span>
                    <div className="relative h-3 flex-1 overflow-hidden rounded-full bg-slate-100 ring-1 ring-slate-200/60">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500 transition-[width] duration-300"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="w-24 shrink-0 text-right text-slate-700 tabular-nums">
                      <span className="font-semibold text-slate-900">
                        {e.count}
                      </span>
                      <span className="ml-1.5 text-xs text-slate-400">
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
