// Polling worker — one tick = "find unclassified open questions, classify
// them, persist". Composed of injectable pieces so tests can stub the LLM
// and the DB independently.

import { classifyQuestion } from "./classify.js";
import { serialiseTopics } from "./taxonomy.js";
import type { Db, UnclassifiedQuestion } from "./db.js";
import type { OpenRouterClient } from "./openrouter.js";
import { log } from "./log.js";

export type WorkerOptions = {
  db: Db;
  client: OpenRouterClient;
  model: string;
  // Maximum rows to classify per tick. Bounds LLM cost during a backlog spike.
  batchSize?: number;
  // Time between ticks, milliseconds.
  pollIntervalMs?: number;
  // Used by tests to stop the loop on a signal other than SIGTERM.
  stopSignal?: AbortSignal;
};

export type TickResult = {
  fetched: number;
  classified: number;
  failed: number;
  raced: number; // row was updated by someone else between fetch and update
};

/**
 * Run one tick of the worker. Public so tests can drive it directly without
 * standing up the setInterval loop.
 */
export async function runOnce(opts: WorkerOptions): Promise<TickResult> {
  const batch = opts.batchSize ?? 20;
  const rows = await opts.db.listUnclassified(batch);
  const result: TickResult = { fetched: rows.length, classified: 0, failed: 0, raced: 0 };

  if (rows.length === 0) return result;

  log.info("tick.start", { fetched: rows.length });

  // Sequential, not parallel: OpenRouter rate-limits per key and we'd rather
  // be cheap and slow than burst-spammy. At pollIntervalMs=10s and 20 rows
  // per tick we keep up with ~120 questions/min sustained, which is plenty
  // for v0.
  for (const row of rows) {
    await classifyOne(row, opts, result);
  }

  log.info("tick.end", result);
  return result;
}

async function classifyOne(
  row: UnclassifiedQuestion,
  opts: WorkerOptions,
  out: TickResult,
): Promise<void> {
  const classify = await classifyQuestion(row.text, row.options, {
    client: opts.client,
    model: opts.model,
  });

  if (!classify.ok) {
    out.failed += 1;
    log.warn("classify.failed", {
      question_id: row.id,
      reason: classify.reason,
    });
    return;
  }

  const topic = serialiseTopics(classify.topics);
  const updated = await opts.db.setTopic(row.id, topic);
  if (updated) {
    out.classified += 1;
    log.info("classify.ok", {
      question_id: row.id,
      topic,
      via: classify.reason,
    });
  } else {
    out.raced += 1;
    log.debug("classify.raced", { question_id: row.id, topic });
  }
}

/**
 * Drive the worker forever, ticking every pollIntervalMs. Returns when the
 * stopSignal aborts (SIGTERM in production, an AbortController in tests).
 */
export async function runForever(opts: WorkerOptions): Promise<void> {
  const interval = opts.pollIntervalMs ?? 10_000;
  const signal = opts.stopSignal;
  while (!signal?.aborted) {
    try {
      await runOnce(opts);
    } catch (err) {
      // Don't let one bad tick kill the loop — the next tick will retry.
      log.error("tick.crashed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (signal?.aborted) break;
    await sleep(interval, signal);
  }
  log.info("loop.stopped");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
