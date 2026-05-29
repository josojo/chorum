// Shared presentation primitives for N-option polls.
//
// Each tally is a record from the question's option labels to counts.
// Yes/No is the 2-option special case: option[0] renders green (yes),
// option[1] renders red (no). For N ≥ 3 each option gets a hue from
// OPTION_PALETTE in declared order, so the same option always reads
// the same colour across charts.

export type OptionTally = Record<string, number>;

export const YES_GRADIENT = "linear-gradient(to right, #34d399, #059669)";
export const NO_GRADIENT = "linear-gradient(to right, #fb7185, #e11d48)";

// 8-color qualitative palette (Tailwind-ish). Order matters: option index i
// always picks OPTION_PALETTE[i] (mod length) so the legend and bars agree.
export const OPTION_PALETTE: ReadonlyArray<{ fill: string; text: string }> = [
  { fill: "linear-gradient(to right, #6366f1, #4338ca)", text: "text-indigo-700" }, // indigo
  { fill: "linear-gradient(to right, #f59e0b, #b45309)", text: "text-amber-700" }, // amber
  { fill: "linear-gradient(to right, #10b981, #047857)", text: "text-emerald-700" }, // emerald
  { fill: "linear-gradient(to right, #ec4899, #be185d)", text: "text-pink-700" }, // pink
  { fill: "linear-gradient(to right, #06b6d4, #0e7490)", text: "text-cyan-700" }, // cyan
  { fill: "linear-gradient(to right, #f97316, #c2410c)", text: "text-orange-700" }, // orange
  { fill: "linear-gradient(to right, #8b5cf6, #6d28d9)", text: "text-violet-700" }, // violet
  { fill: "linear-gradient(to right, #64748b, #334155)", text: "text-slate-700" }, // slate
];

export function isYesNo(options: readonly string[]): boolean {
  return (
    options.length === 2 &&
    options[0].trim().toLowerCase() === "yes" &&
    options[1].trim().toLowerCase() === "no"
  );
}

export function paletteFor(options: readonly string[]): string[] {
  if (isYesNo(options)) return [YES_GRADIENT, NO_GRADIENT];
  return options.map((_, i) => OPTION_PALETTE[i % OPTION_PALETTE.length].fill);
}

export function textColorFor(options: readonly string[], i: number): string {
  if (isYesNo(options)) {
    return i === 0 ? "text-emerald-700" : "text-rose-700";
  }
  return OPTION_PALETTE[i % OPTION_PALETTE.length].text;
}

export function isTally(v: unknown): v is OptionTally {
  if (typeof v !== "object" || v === null) return false;
  for (const k of Object.keys(v as Record<string, unknown>)) {
    const n = (v as Record<string, unknown>)[k];
    if (typeof n !== "number" || !Number.isFinite(n)) return false;
  }
  return true;
}

export function tallyTotal(t: OptionTally | undefined | null): number {
  if (!t) return 0;
  let sum = 0;
  for (const k of Object.keys(t)) sum += t[k] ?? 0;
  return sum;
}

/**
 * A horizontal bar split across the question's options. The filled width
 * encodes the cohort's magnitude (count / section max); the segments inside
 * encode each option's share of that cohort's responses.
 */
export function OptionsBar({
  tally,
  options,
  widthPct,
}: {
  tally: OptionTally;
  options: readonly string[];
  widthPct: number;
}) {
  const total = tallyTotal(tally);
  const fills = paletteFor(options);
  return (
    <div className="relative h-3 w-full overflow-hidden rounded-full bg-slate-100 ring-1 ring-slate-200/60">
      <div
        className="flex h-full overflow-hidden rounded-full transition-[width] duration-300"
        style={{ width: `${widthPct}%` }}
      >
        {options.map((opt, i) => {
          const n = tally[opt] ?? 0;
          const segPct = total === 0 ? 0 : (n / total) * 100;
          if (segPct === 0) return null;
          return (
            <div
              key={opt}
              style={{ width: `${segPct}%`, background: fills[i] }}
              title={`${opt}: ${n}`}
            />
          );
        })}
      </div>
    </div>
  );
}

/** Inline "Yes N · No M" style counter, generalised across options. */
export function OptionsCount({
  tally,
  options,
}: {
  tally: OptionTally;
  options: readonly string[];
}) {
  return (
    <span className="tabular-nums">
      {options.map((opt, i) => {
        const n = tally[opt] ?? 0;
        return (
          <span key={opt}>
            <span className={`font-semibold ${textColorFor(options, i)}`}>{n}</span>
            <span className="ml-0.5 text-slate-400">{opt.toLowerCase()}</span>
            {i < options.length - 1 ? (
              <span className="mx-1 text-slate-300">·</span>
            ) : null}
          </span>
        );
      })}
    </span>
  );
}

/** Legend explaining the colour coding for this question's options. */
export function OptionsLegend({ options }: { options: readonly string[] }) {
  const fills = paletteFor(options);
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
      {options.map((opt, i) => (
        <span key={opt} className="inline-flex items-center gap-1.5">
          <span
            className="h-2.5 w-2.5 rounded-full"
            style={{ background: fills[i] }}
          />
          {opt}
        </span>
      ))}
    </div>
  );
}
