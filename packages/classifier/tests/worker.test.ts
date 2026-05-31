// Worker tick tests with in-memory DB + scripted LLM. Asserts:
//   - happy path: row gets classified, persisted, counted
//   - failure path: row stays NULL, no UPDATE issued
//   - race path: another writer set topic between fetch and UPDATE
//   - one bad row doesn't poison the batch
//   - runForever respects stopSignal and shuts down

import { describe, it, expect, vi } from "vitest";
import { runForever, runOnce } from "../src/worker.js";
import type { Db, UnclassifiedQuestion } from "../src/db.js";
import type { OpenRouterClient } from "../src/openrouter.js";

type Reply =
  | { kind: "ok"; tokens: string[] }
  | { kind: "non-json"; raw: string }
  | { kind: "throw"; message: string };

function buildClient(replies: Reply[]): OpenRouterClient {
  let i = 0;
  return {
    async chat() {
      const r = replies[i++];
      if (!r) throw new Error("no more scripted replies");
      if (r.kind === "throw") throw new Error(r.message);
      if (r.kind === "non-json") return { content: r.raw };
      return { content: JSON.stringify({ tokens: r.tokens }) };
    },
  };
}

function buildDb(initial: UnclassifiedQuestion[]): Db & {
  updates: Array<{ id: string; topic: string }>;
  raceOn?: Set<string>;
} {
  let queue = [...initial];
  const updates: Array<{ id: string; topic: string }> = [];
  const raceOn = new Set<string>();
  return {
    updates,
    raceOn,
    async listUnclassified(limit) {
      const out = queue.slice(0, limit);
      // Worker is expected to UPDATE; subsequent listUnclassified should not
      // re-return rows it has already handled.
      queue = queue.slice(limit);
      return out;
    },
    async setTopic(id, topic) {
      if (raceOn.has(id)) return false;
      updates.push({ id, topic });
      return true;
    },
    async close() {},
  };
}

const Q = (id: string, text: string): UnclassifiedQuestion => ({
  id,
  text,
  options: ["yes", "no"],
});

describe("runOnce", () => {
  it("classifies and persists every fetched row", async () => {
    const db = buildDb([Q("q1", "A"), Q("q2", "B")]);
    const client = buildClient([
      { kind: "ok", tokens: ["ai"] },
      { kind: "ok", tokens: ["food"] },
    ]);

    const result = await runOnce({ db, client, model: "m" });

    expect(result).toEqual({ fetched: 2, classified: 2, failed: 0, raced: 0 });
    expect(db.updates).toEqual([
      { id: "q1", topic: "ai" },
      { id: "q2", topic: "food" },
    ]);
  });

  it("leaves a row NULL when the classifier fails", async () => {
    const db = buildDb([Q("q1", "A")]);
    const client = buildClient([{ kind: "non-json", raw: "Sure thing!" }]);

    const result = await runOnce({ db, client, model: "m" });

    expect(result).toEqual({ fetched: 1, classified: 0, failed: 1, raced: 0 });
    expect(db.updates).toEqual([]);
  });

  it("counts races but does not error", async () => {
    const db = buildDb([Q("q1", "A")]);
    db.raceOn!.add("q1");
    const client = buildClient([{ kind: "ok", tokens: ["ai"] }]);

    const result = await runOnce({ db, client, model: "m" });

    expect(result).toEqual({ fetched: 1, classified: 0, failed: 0, raced: 1 });
    expect(db.updates).toEqual([]);
  });

  it("one bad row does not break the batch", async () => {
    const db = buildDb([Q("q1", "A"), Q("q2", "B"), Q("q3", "C")]);
    const client = buildClient([
      { kind: "ok", tokens: ["ai"] },
      { kind: "throw", message: "boom" },
      { kind: "ok", tokens: ["food"] },
    ]);

    const result = await runOnce({ db, client, model: "m" });

    expect(result).toEqual({ fetched: 3, classified: 2, failed: 1, raced: 0 });
    expect(db.updates).toEqual([
      { id: "q1", topic: "ai" },
      { id: "q3", topic: "food" },
    ]);
  });

  it("returns early when nothing is pending", async () => {
    const db = buildDb([]);
    let calls = 0;
    const client: OpenRouterClient = {
      async chat() {
        calls++;
        return { content: '{"tokens":["ai"]}' };
      },
    };
    const result = await runOnce({ db, client, model: "m" });
    expect(result).toEqual({ fetched: 0, classified: 0, failed: 0, raced: 0 });
    expect(calls).toBe(0);
  });

  it("respects batchSize", async () => {
    const db = buildDb([
      Q("q1", "A"),
      Q("q2", "B"),
      Q("q3", "C"),
      Q("q4", "D"),
    ]);
    const client = buildClient([
      { kind: "ok", tokens: ["ai"] },
      { kind: "ok", tokens: ["food"] },
    ]);
    const result = await runOnce({ db, client, model: "m", batchSize: 2 });
    expect(result.fetched).toBe(2);
    expect(db.updates).toHaveLength(2);
  });

  it("serialises multi-topic results into a space-joined string", async () => {
    const db = buildDb([Q("q1", "is gemini better than gpt for refactoring code?")]);
    const client = buildClient([{ kind: "ok", tokens: ["ai", "coding"] }]);
    await runOnce({ db, client, model: "m" });
    expect(db.updates).toEqual([{ id: "q1", topic: "ai coding" }]);
  });
});

describe("runForever", () => {
  it("stops when stopSignal aborts and surfaces no errors", async () => {
    vi.useFakeTimers();
    const db = buildDb([]);
    const client = buildClient([]);
    const ac = new AbortController();

    const promise = runForever({
      db,
      client,
      model: "m",
      pollIntervalMs: 10_000,
      stopSignal: ac.signal,
    });

    // First tick runs immediately (empty queue → no-op); loop then awaits sleep.
    await vi.advanceTimersByTimeAsync(0);
    ac.abort();
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    vi.useRealTimers();
  });
});
