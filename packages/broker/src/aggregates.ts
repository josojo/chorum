// Aggregate helpers.
//
// Accepted envelopes increment the aggregates row in the same transaction as the
// envelope INSERT. Questions carry an ordered `options` list (default
// ["yes","no"]); by_predicate records per-option counts inside each disclosed
// (predicate, value) bucket, e.g.
//   {"region:EU": {"yes": 30, "no": 12}, "age_band:25-34": {"yes": 20, "no": 10}}
// total_answers is the grand count of accepted envelopes; answers whose leading
// word matches no option still count toward the total but no per-option bucket.

// Multilingual yes/no synonyms — used only when the question's options are the
// default ["yes","no"] so existing demo / seeded polls keep working.
const YES_WORDS = new Set([
  "yes", "y", "yeah", "yep", "yup", "sure", "absolutely",
  "ja", "oui", "si", "sí", "sim", "da",
]);
const NO_WORDS = new Set([
  "no", "n", "nope", "nah", "never",
  "nein", "non", "não", "nao",
]);

function isYesNo(options: readonly string[]): boolean {
  return (
    options.length === 2 &&
    options[0].trim().toLowerCase() === "yes" &&
    options[1].trim().toLowerCase() === "no"
  );
}

function leadingWord(answer: unknown): string | null {
  if (typeof answer !== "string") return null;
  const m = /^[\p{L}\p{N}_]+/u.exec(answer.trim().toLowerCase());
  return m ? m[0] : null;
}

// Return the option label that `answer` selects, or null. Match strategy:
// leading-word, case-insensitive — robust to LLM elaboration. For the default
// ["yes","no"] poll we additionally accept multilingual yes/no synonyms.
export function classifyAnswer(answer: unknown, options: readonly string[]): string | null {
  const word = leadingWord(answer);
  if (word === null) return null;
  const byLabel = new Map<string, string>();
  for (const opt of options) byLabel.set(opt.trim().toLowerCase(), opt);
  if (byLabel.has(word)) return byLabel.get(word)!;
  if (isYesNo(options)) {
    if (YES_WORDS.has(word)) return "yes";
    if (NO_WORDS.has(word)) return "no";
  }
  return null;
}

function emptyTally(options: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const opt of options) out[opt] = 0;
  return out;
}

export interface EnvelopeRow {
  answer: unknown;
  disclosed_predicates: Record<string, string> | string | null;
  // §1.14: true when the agent had no formed view. Optional for back-compat with
  // rows/fixtures predating the column (treated as a normal signal answer).
  no_signal?: boolean;
}

// Pure function, the no_signal counterpart of computeByPredicate (§1.14). Each
// no_signal envelope contributes 1 to every disclosed (predicate, value) bucket;
// signal answers contribute nothing. Returns {total, byPredicate}.
export function computeNoSignal(envelopes: Iterable<EnvelopeRow>): {
  total: number;
  byPredicate: Record<string, number>;
} {
  let total = 0;
  const byPredicate: Record<string, number> = {};
  for (const env of envelopes) {
    if (env.no_signal !== true) continue;
    total += 1;
    let preds = env.disclosed_predicates ?? {};
    if (typeof preds === "string") preds = JSON.parse(preds);
    for (const [k, v] of Object.entries(preds as Record<string, string>)) {
      const key = `${k}:${v}`;
      byPredicate[key] = (byPredicate[key] ?? 0) + 1;
    }
  }
  return { total, byPredicate };
}

// Pure function. Each envelope contributes its classified option to every
// disclosed (predicate, value) bucket. Unclassified answers count toward
// total_answers (computed by the caller) but not toward any per-option bucket.
export function computeByPredicate(
  envelopes: Iterable<EnvelopeRow>,
  options: readonly string[] = ["yes", "no"],
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const env of envelopes) {
    let preds = env.disclosed_predicates ?? {};
    if (typeof preds === "string") preds = JSON.parse(preds);
    const choice = classifyAnswer(env.answer, options);
    for (const [k, v] of Object.entries(preds as Record<string, string>)) {
      const key = `${k}:${v}`;
      let bucket = out[key];
      if (bucket === undefined) {
        bucket = emptyTally(options);
        out[key] = bucket;
      }
      // Defensive: fill any option added since the bucket was created.
      for (const opt of options) if (!(opt in bucket)) bucket[opt] = 0;
      if (choice !== null) bucket[choice] = (bucket[choice] ?? 0) + 1;
    }
  }
  return out;
}
