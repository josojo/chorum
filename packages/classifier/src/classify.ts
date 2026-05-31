// Pure classifier: question text + options → taxonomy topics.
//
// Talks to OpenRouter (a cheap flash-tier model is plenty for tagging) and
// applies a strict allow-list filter against the taxonomy. The function is
// "pure" in the sense that the only side-effect is the HTTP call — no DB I/O,
// no logging. The worker (worker.ts) owns persistence and observability.

import {
  FALLBACK_TOPIC,
  SAFE_TOPICS,
  SENSITIVE_TOPICS,
  normaliseTopics,
  type Topic,
} from "./taxonomy.js";
import {
  OpenRouterError,
  type ChatCompletionRequest,
  type OpenRouterClient,
} from "./openrouter.js";

export type ClassifierOptions = {
  client: OpenRouterClient;
  model: string;
  // Cap on tokens returned. The taxonomy expects 1..3 — three lets us tag a
  // crossover question (e.g. "Is it ethical for AI to do my taxes?" → ai +
  // finance + philosophy) without over-spamming the agent's word-token matcher.
  maxTokens?: number;
};

export type ClassifyResult =
  | { ok: true; topics: Topic[]; reason: "model" | "fallback" }
  // ok:false means the classifier could not reach a confident answer (HTTP
  // failure, malformed JSON, ALL tokens out of taxonomy). The caller (worker)
  // leaves the row's topic NULL so it stays hidden from agents and gets
  // retried on the next tick — fail-closed.
  | { ok: false; reason: string };

const SYSTEM_PROMPT = buildSystemPrompt();

/**
 * Classify a question into 1..maxTopics taxonomy tokens. Never throws —
 * returns ok:false on any failure so the worker can leave the row NULL
 * (the fail-closed shape the broker relies on).
 */
export async function classifyQuestion(
  text: string,
  options: readonly string[],
  opts: ClassifierOptions,
): Promise<ClassifyResult> {
  const maxTopics = opts.maxTokens ?? 3;

  const userPrompt = JSON.stringify({
    question: truncate(text, 4_000),
    options: options.slice(0, 8).map((o) => truncate(o, 80)),
  });

  const req: ChatCompletionRequest = {
    model: opts.model,
    temperature: 0,
    maxTokens: 64,
    responseFormat: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
  };

  let raw: string;
  try {
    const resp = await opts.client.chat(req);
    raw = resp.content;
  } catch (err) {
    const detail =
      err instanceof OpenRouterError
        ? `${err.message}${err.status !== null ? ` (status=${err.status})` : ""}`
        : err instanceof Error
          ? err.message
          : String(err);
    return { ok: false, reason: `llm-call-failed: ${detail}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      reason: `non-json-response: ${truncate(raw, 200)}`,
    };
  }

  const tokensField = (parsed as { tokens?: unknown }).tokens;
  const topics = normaliseTopics(tokensField, maxTopics);
  if (topics.length === 0) {
    // The model returned valid JSON but no usable taxonomy token. Don't fall
    // back to "other" silently — that would mask a misconfiguration. Treat as
    // a soft failure; the worker retries next tick. The model has to be wrong
    // every tick for the question to stay hidden, so a one-off blip is
    // self-healing.
    return {
      ok: false,
      reason: `no-valid-tokens: ${truncate(raw, 200)}`,
    };
  }
  // The model explicitly chose `other` — that IS a real classification.
  const reason = topics.length === 1 && topics[0] === FALLBACK_TOPIC ? "fallback" : "model";
  return { ok: true, topics, reason };
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + "…";
}

function buildSystemPrompt(): string {
  return [
    "You tag public questions with topic tokens from a fixed taxonomy.",
    "",
    "TAXONOMY (case-sensitive — copy tokens exactly):",
    `safe:      ${SAFE_TOPICS.join(", ")}`,
    `sensitive: ${SENSITIVE_TOPICS.join(", ")}`,
    `fallback:  ${FALLBACK_TOPIC}`,
    "",
    "Reply with a single JSON object of shape:",
    '  { "tokens": ["<token>", "<token>", ...] }',
    "",
    "Rules:",
    "1. Pick 1 to 3 tokens, ordered most relevant first.",
    "2. Every token MUST appear in the taxonomy above, verbatim. Never invent a token.",
    "3. Pick from `sensitive` whenever the question touches health, money, politics, religion,",
    "   relationships, family, education, work, news, philosophy, legal advice, or anything",
    `   personal — even if it could also be tagged from \`safe\`. The label must reflect what`,
    "   the question is REALLY about, not how it is phrased.",
    "4. Use `other` ONLY if no taxonomy member fits — never as filler.",
    "5. Reply with the JSON object only — no prose, no markdown fence.",
  ].join("\n");
}
