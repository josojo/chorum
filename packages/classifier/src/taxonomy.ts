// Canonical topic taxonomy — mirror of packages/proto/topics.json.
//
// Why duplicate the list here in TS:
//   - This package builds to a Docker image; pulling a JSON file from another
//     workspace at runtime would force either a build-time bundling step or a
//     volume mount. A flat TS constant is simpler and is checked against the
//     proto file by tests/taxonomy.test.ts so they cannot drift.
//   - The proto file is the human-facing source of truth (referenced from
//     ARCHITECTURE.md and the broker/skill docs).
//
// Cross-cuts:
//   - SAFE_TOPICS must be a subset (by word-token match) of
//     DEFAULT_AUTO_ANSWER_TOPICS in packages/skill/src/hearme_skill/policy.py
//     so the skill auto-answers them out of the box.
//   - SENSITIVE_TOPICS must NOT match anything in DEFAULT_AUTO_ANSWER_TOPICS
//     so the skill declines them until the user sets `auto_answer: true`.
//   - FALLBACK ("other") is in neither — agents whose policy doesn't include
//     "other" decline it; that's the right "untagged" semantics.

export const SAFE_TOPICS = [
  "ai",
  "tech",
  "software",
  "coding",
  "gaming",
  "music",
  "movies",
  "books",
  "food",
  "travel",
  "sports",
  "photography",
  "art",
  "science",
  "productivity",
  "web",
] as const;

export const SENSITIVE_TOPICS = [
  "politics",
  "health",
  "finance",
  "religion",
  "relationships",
  "family",
  "education",
  "work",
  "news",
  "philosophy",
  "legal",
  "personal",
] as const;

export const FALLBACK_TOPIC = "other" as const;

export type SafeTopic = (typeof SAFE_TOPICS)[number];
export type SensitiveTopic = (typeof SENSITIVE_TOPICS)[number];
export type Topic = SafeTopic | SensitiveTopic | typeof FALLBACK_TOPIC;

// All tokens the classifier is ALLOWED to emit. Anything outside this set is
// rejected (and replaced by FALLBACK) so a hallucinated label can never reach
// the broker row.
const ALL_TOPICS: ReadonlySet<string> = new Set<string>([
  ...SAFE_TOPICS,
  ...SENSITIVE_TOPICS,
  FALLBACK_TOPIC,
]);

export function isValidTopic(token: string): token is Topic {
  return ALL_TOPICS.has(token);
}

/**
 * Normalise an LLM response — array of arbitrary strings — into a canonical
 * topic list. Lowercases, trims, drops duplicates, drops anything not in the
 * taxonomy. Returns at most `max` tokens, in the order they first appeared.
 *
 * Returns an empty array if NOTHING valid survived; the caller decides
 * whether to retry, fall back to "other", or leave the row NULL.
 */
export function normaliseTopics(raw: unknown, max = 3): Topic[] {
  if (!Array.isArray(raw)) return [];
  const out: Topic[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const tok = item.trim().toLowerCase();
    if (!tok || seen.has(tok)) continue;
    if (!isValidTopic(tok)) continue;
    seen.add(tok);
    out.push(tok);
    if (out.length >= max) break;
  }
  return out;
}

// Storage shape on the questions.topic column: a single TEXT value containing
// one or more topic tokens separated by single ASCII spaces. The skill's
// policy.py word-tokeniser (re.findall(r"[a-z0-9]+", topic)) already handles
// this — no skill change is needed for multi-topic.
export function serialiseTopics(topics: readonly Topic[]): string {
  return topics.join(" ");
}
