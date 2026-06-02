// Tests for the /ask server action.
//
// We test:
//   1. validateCreateQuestion — pure validation, exhaustive.
//   2. createQuestion — happy path with an in-memory fake Drizzle handle.
//
// We intentionally don't test createQuestionAction end-to-end here because
// it calls Next's `redirect()`, which throws a special error and is annoying
// to fake outside a Next request context. Validation + DB insertion is the
// load-bearing logic; the action is a thin shell that ties them together.

import { describe, it, expect, vi } from "vitest";
import { createQuestion } from "../src/actions/create-question";
import {
  validateCreateQuestion,
  type CreateQuestionInput,
} from "../src/actions/validate-question";

// ---------- validateCreateQuestion ----------

describe("validateCreateQuestion", () => {
  const futureDate = new Date(Date.now() + 86_400_000);

  it("accepts a valid worldwide input", () => {
    const r = validateCreateQuestion({
      displayName: "Alice",
      text: "Should we ship?",
      closesAt: futureDate,
      scope: "worldwide",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.displayName).toBe("Alice");
      expect(r.value.scope).toBe("worldwide");
      expect(r.value.country).toBeNull();
      expect(r.value.continent).toBeNull();
      // The asker no longer chooses the topic — that's the classifier's job.
      expect(r.value).not.toHaveProperty("topic");
      // Default options are Yes / No.
      expect(r.value).toEqual(
        expect.objectContaining({ options: ["Yes", "No"] }),
      );
    }
  });

  it("silently drops any asker-supplied topic (anti-bypass)", () => {
    // Asker control over topic would let "Is metformin worth the side effects?"
    // be labelled `ai` and slip past the skill's sensitive-topic gate. The
    // classifier service is the only authority; the validator must therefore
    // not propagate any topic the form happens to send.
    const r = validateCreateQuestion({
      displayName: "Alice",
      text: "Should we ship?",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...({ topic: "ai" } as any),
      closesAt: futureDate,
      scope: "worldwide",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).not.toHaveProperty("topic");
    }
  });

  it("accepts custom options when supplied", () => {
    const r = validateCreateQuestion({
      displayName: "Alice",
      text: "Pizza, pasta, or sushi?",
      closesAt: futureDate,
      scope: "worldwide",
      options: ["Pizza", "Pasta", "Sushi"],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.options).toEqual(["Pizza", "Pasta", "Sushi"]);
  });

  it("trims and drops empty option rows", () => {
    const r = validateCreateQuestion({
      displayName: "Alice",
      text: "Q?",
      closesAt: futureDate,
      scope: "worldwide",
      options: ["  Yes  ", "", "No", "   "],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.options).toEqual(["Yes", "No"]);
  });

  it("rejects fewer than two options", () => {
    const r = validateCreateQuestion({
      displayName: "Alice",
      text: "Q?",
      closesAt: futureDate,
      scope: "worldwide",
      options: ["only-one"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.options).toBeTruthy();
  });

  it("rejects more than eight options", () => {
    const r = validateCreateQuestion({
      displayName: "Alice",
      text: "Q?",
      closesAt: futureDate,
      scope: "worldwide",
      options: ["a", "b", "c", "d", "e", "f", "g", "h", "i"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.options).toBeTruthy();
  });

  it("rejects duplicate options (case-insensitive)", () => {
    const r = validateCreateQuestion({
      displayName: "Alice",
      text: "Q?",
      closesAt: futureDate,
      scope: "worldwide",
      options: ["Yes", "yes"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.options).toBeTruthy();
  });

  it("rejects too-long option labels", () => {
    const r = validateCreateQuestion({
      displayName: "Alice",
      text: "Q?",
      closesAt: futureDate,
      scope: "worldwide",
      options: ["Yes", "n".repeat(50)],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.options).toBeTruthy();
  });

  it("accepts a country-scoped input and derives continent", () => {
    const r = validateCreateQuestion({
      displayName: "Alice",
      text: "Should we ship?",
      closesAt: futureDate,
      scope: "country",
      country: "DE",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.scope).toBe("country");
      expect(r.value.country).toBe("DE");
      expect(r.value.continent).toBe("EU");
    }
  });

  it("accepts a continent-scoped input", () => {
    const r = validateCreateQuestion({
      displayName: "Alice",
      text: "Should we ship?",
      closesAt: futureDate,
      scope: "continent",
      continent: "AS",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.scope).toBe("continent");
      expect(r.value.continent).toBe("AS");
      expect(r.value.country).toBeNull();
    }
  });

  it("rejects continent scope without continent", () => {
    const r = validateCreateQuestion({
      displayName: "Alice",
      text: "Hi?",
      closesAt: futureDate,
      scope: "continent",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.continent).toBeTruthy();
  });

  it("rejects country scope without country", () => {
    const r = validateCreateQuestion({
      displayName: "Alice",
      text: "Hi?",
      closesAt: futureDate,
      scope: "country",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.country).toBeTruthy();
  });

  it("trims whitespace", () => {
    const r = validateCreateQuestion({
      displayName: "  Alice  ",
      text: "  hello?  ",
      closesAt: futureDate,
      scope: "worldwide",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.displayName).toBe("Alice");
      expect(r.value.text).toBe("hello?");
    }
  });

  it("rejects missing display_name", () => {
    const r = validateCreateQuestion({
      displayName: "",
      text: "Hi?",
      closesAt: futureDate,
      scope: "worldwide",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.displayName).toBeTruthy();
  });

  it("rejects missing text", () => {
    const r = validateCreateQuestion({
      displayName: "Alice",
      text: "   ",
      closesAt: futureDate,
      scope: "worldwide",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.text).toBeTruthy();
  });

  it("rejects past closes_at", () => {
    const r = validateCreateQuestion({
      displayName: "Alice",
      text: "Hi?",
      closesAt: new Date(Date.now() - 60_000),
      scope: "worldwide",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.closesAt).toBeTruthy();
  });

  it("rejects too-long text", () => {
    const r = validateCreateQuestion({
      displayName: "Alice",
      text: "a".repeat(2001),
      closesAt: futureDate,
      scope: "worldwide",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.text).toBeTruthy();
  });
});

// ---------- createQuestion (happy path) ----------

 /**
  * Build a fake Drizzle handle that records the calls the action makes.
 * We mimic just enough surface to satisfy the chained
 * `.insert()...returning()` flows.
 */
function buildFakeDb(opts: {
  newAskerId?: string;
  newQuestionId?: string;
}) {
  const calls: { kind: string; args: unknown }[] = [];

  const insert = vi.fn((_table: unknown) => {
    return {
      values: (vals: unknown) => {
        return {
          returning: async () => {
            // The first insert is the display-only asker row; the second is
            // the question. We disambiguate by inspecting the values.
            if (vals && typeof vals === "object" && "displayName" in vals) {
              calls.push({ kind: "insert-asker", args: vals });
              return [{ id: opts.newAskerId ?? "asker-uuid" }];
            }
            calls.push({ kind: "insert-question", args: vals });
            return [{ id: opts.newQuestionId ?? "question-uuid" }];
          },
        };
      },
    };
  });

  return {
    fake: { insert } as unknown as Parameters<
      typeof createQuestion
    >[1],
    calls,
  };
}

describe("createQuestion", () => {
  const input: CreateQuestionInput = {
    displayName: "Alice",
    text: "Should we ship today?",
    options: ["Yes", "No"],
    closesAt: new Date(Date.now() + 86_400_000),
    scope: "worldwide",
    country: null,
    continent: null,
  };

  it("creates a fresh asker display row, then inserts the question", async () => {
    const { fake, calls } = buildFakeDb({
      newAskerId: "asker-1",
      newQuestionId: "question-1",
    });
    const r = await createQuestion(input, fake);
    expect(r.questionId).toBe("question-1");

    const kinds = calls.map((c) => c.kind);
    expect(kinds).toEqual(["insert-asker", "insert-question"]);

    const qInsert = calls.find((c) => c.kind === "insert-question")!
      .args as Record<string, unknown>;
    expect(qInsert.askerId).toBe("asker-1");
    expect(qInsert.text).toBe(input.text);
    expect(qInsert.options).toEqual(["Yes", "No"]);
    // The insert must NOT set `topic` — the classifier service will fill it
    // later. Setting it here from asker input would re-open the bypass.
    expect(qInsert).not.toHaveProperty("topic");
  });

  it("forwards custom options to the insert", async () => {
    const { fake, calls } = buildFakeDb({});
    await createQuestion(
      { ...input, options: ["Pizza", "Pasta", "Sushi"] },
      fake,
    );
    const qInsert = calls.find((c) => c.kind === "insert-question")!
      .args as Record<string, unknown>;
    expect(qInsert.options).toEqual(["Pizza", "Pasta", "Sushi"]);
  });

  it("leaves unique_identifier NULL for an unauthenticated (display-only) ask", async () => {
    const { fake, calls } = buildFakeDb({});
    await createQuestion(input, fake);
    const askerInsert = calls.find((c) => c.kind === "insert-asker")!
      .args as Record<string, unknown>;
    expect(askerInsert.uniqueIdentifier).toBeNull();
  });

  it("stamps the verified unique_identifier on the asker row (§14.2)", async () => {
    const { fake, calls } = buildFakeDb({});
    await createQuestion(input, fake, "self:verified-asker");
    const askerInsert = calls.find((c) => c.kind === "insert-asker")!
      .args as Record<string, unknown>;
    expect(askerInsert.uniqueIdentifier).toBe("self:verified-asker");
  });
});
