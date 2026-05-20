// Age-demographics chart. Replaces the plain "age_band" bar list with a
// fuller-bodied chart: each cohort gets a gradient bar sized to its share
// of the total, with the absolute count and percentage rendered inline.

export type AgeDatum = {
  band: string;
  count: number;
};

export type AgeChartProps = {
  data: AgeDatum[];
  total: number;
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

// Per-cohort colour gradient — young cohorts trend teal, older cohorts trend
// rose, with violet in the middle. Keeps the bars visually distinguishable
// without leaning on a single hue.
const BAND_COLORS: Record<string, [string, string]> = {
  "0-17": ["#5eead4", "#0d9488"],
  "18-24": ["#22d3ee", "#0e7490"],
  "25-34": ["#818cf8", "#4338ca"],
  "35-44": ["#a78bfa", "#6d28d9"],
  "45-54": ["#c084fc", "#7e22ce"],
  "55-64": ["#e879f9", "#a21caf"],
  "55+": ["#f472b6", "#9d174d"],
  "65+": ["#fb7185", "#9f1239"],
};

const FALLBACK_GRADIENT: [string, string] = ["#94a3b8", "#475569"];

function sortBands(data: AgeDatum[]): AgeDatum[] {
  const indexOf = (b: string) => {
    const i = BAND_ORDER.indexOf(b);
    return i === -1 ? 999 : i;
  };
  return [...data].sort((a, b) => indexOf(a.band) - indexOf(b.band));
}

export function AgeChart({ data, total }: AgeChartProps) {
  const sorted = sortBands(data);
  const max = sorted.reduce((m, e) => (e.count > m ? e.count : m), 0);
  const cohortSum = sorted.reduce((s, e) => s + e.count, 0);
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
        const widthPct = max === 0 ? 0 : (e.count / max) * 100;
        const sharePct = denom === 0 ? 0 : (e.count / denom) * 100;
        const [from, to] = BAND_COLORS[e.band] ?? FALLBACK_GRADIENT;
        return (
          <div key={e.band} className="space-y-1">
            <div className="flex items-baseline justify-between text-sm">
              <span className="font-medium text-slate-700">{e.band}</span>
              <span className="tabular-nums text-slate-500">
                <span className="font-semibold text-slate-900">{e.count}</span>
                <span className="ml-2 text-xs text-slate-400">
                  {sharePct.toFixed(1)}%
                </span>
              </span>
            </div>
            <div className="relative h-3 overflow-hidden rounded-full bg-slate-100 ring-1 ring-slate-200/60">
              <div
                className="h-full rounded-full shadow-inner transition-[width] duration-300"
                style={{
                  width: `${widthPct}%`,
                  background: `linear-gradient(to right, ${from}, ${to})`,
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
