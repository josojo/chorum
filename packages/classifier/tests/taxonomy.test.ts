// Verifies the in-package taxonomy matches packages/proto/topics.json — the
// proto file is the cross-language source of truth, this TS copy is what the
// running worker emits. Drift would silently let the classifier emit tokens
// the skill never trained against (or vice versa).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  FALLBACK_TOPIC,
  SAFE_TOPICS,
  SENSITIVE_TOPICS,
  isValidTopic,
  normaliseTopics,
  serialiseTopics,
} from "../src/taxonomy.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = join(__dirname, "..", "..", "proto", "topics.json");

const proto = JSON.parse(readFileSync(PROTO_PATH, "utf8")) as {
  safe: string[];
  sensitive: string[];
  fallback: string;
};

describe("taxonomy ↔ proto/topics.json", () => {
  it("safe set matches proto exactly", () => {
    expect([...SAFE_TOPICS]).toEqual(proto.safe);
  });

  it("sensitive set matches proto exactly", () => {
    expect([...SENSITIVE_TOPICS]).toEqual(proto.sensitive);
  });

  it("fallback token matches proto", () => {
    expect(FALLBACK_TOPIC).toBe(proto.fallback);
  });

  it("safe and sensitive sets are disjoint", () => {
    const s = new Set<string>(SAFE_TOPICS);
    for (const t of SENSITIVE_TOPICS) expect(s.has(t)).toBe(false);
  });

  it("fallback is not in either set", () => {
    expect(SAFE_TOPICS as readonly string[]).not.toContain(FALLBACK_TOPIC);
    expect(SENSITIVE_TOPICS as readonly string[]).not.toContain(FALLBACK_TOPIC);
  });
});

describe("isValidTopic", () => {
  it("accepts known safe tokens", () => {
    expect(isValidTopic("ai")).toBe(true);
    expect(isValidTopic("food")).toBe(true);
  });
  it("accepts known sensitive tokens", () => {
    expect(isValidTopic("health")).toBe(true);
    expect(isValidTopic("politics")).toBe(true);
  });
  it("accepts the fallback token", () => {
    expect(isValidTopic("other")).toBe(true);
  });
  it("rejects unknown tokens", () => {
    expect(isValidTopic("hacking")).toBe(false);
    expect(isValidTopic("AI")).toBe(false); // case matters
    expect(isValidTopic("")).toBe(false);
  });
});

describe("normaliseTopics", () => {
  it("returns [] when input is not an array", () => {
    expect(normaliseTopics("ai")).toEqual([]);
    expect(normaliseTopics(null)).toEqual([]);
    expect(normaliseTopics(undefined)).toEqual([]);
    expect(normaliseTopics({ tokens: ["ai"] })).toEqual([]);
  });

  it("lowercases and trims", () => {
    expect(normaliseTopics(["  AI ", "Food"])).toEqual(["ai", "food"]);
  });

  it("drops duplicates, preserving first occurrence order", () => {
    expect(normaliseTopics(["ai", "AI", "food", "ai"])).toEqual(["ai", "food"]);
  });

  it("drops tokens not in the taxonomy", () => {
    expect(normaliseTopics(["ai", "hacking", "food"])).toEqual(["ai", "food"]);
  });

  it("caps at max", () => {
    expect(
      normaliseTopics(["ai", "tech", "software", "coding"], 2),
    ).toEqual(["ai", "tech"]);
  });

  it("drops non-string items", () => {
    expect(normaliseTopics(["ai", 42, null, "food"])).toEqual(["ai", "food"]);
  });

  it("returns [] if nothing valid survives", () => {
    expect(normaliseTopics(["hacking", "stuff", "blah"])).toEqual([]);
  });
});

describe("serialiseTopics", () => {
  it("space-joins tokens", () => {
    expect(serialiseTopics(["ai", "food"])).toBe("ai food");
  });
  it("handles single token", () => {
    expect(serialiseTopics(["ai"])).toBe("ai");
  });
});
