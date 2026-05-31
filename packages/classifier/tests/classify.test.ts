// classifyQuestion behaviour: prompt shape, response parsing, failure modes.

import { describe, it, expect } from "vitest";
import { classifyQuestion } from "../src/classify.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  OpenRouterClient,
} from "../src/openrouter.js";

function stubClient(handler: (req: ChatCompletionRequest) => ChatCompletionResponse | Promise<ChatCompletionResponse>): OpenRouterClient & {
  calls: ChatCompletionRequest[];
} {
  const calls: ChatCompletionRequest[] = [];
  return {
    calls,
    async chat(req) {
      calls.push(req);
      return handler(req);
    },
  };
}

describe("classifyQuestion", () => {
  it("returns model-classified topics on a clean reply", async () => {
    const client = stubClient(() => ({
      content: JSON.stringify({ tokens: ["ai", "philosophy"] }),
    }));

    const res = await classifyQuestion(
      "Is it ethical for an AI to do my taxes?",
      ["yes", "no"],
      { client, model: "test/model" },
    );

    expect(res).toEqual({
      ok: true,
      topics: ["ai", "philosophy"],
      reason: "model",
    });
  });

  it("flags reason='fallback' when the model picks 'other' alone", async () => {
    const client = stubClient(() => ({
      content: JSON.stringify({ tokens: ["other"] }),
    }));
    const res = await classifyQuestion("zzzzz", ["yes", "no"], {
      client,
      model: "m",
    });
    expect(res).toEqual({ ok: true, topics: ["other"], reason: "fallback" });
  });

  it("sends a JSON-mode request at temperature 0 with the system prompt", async () => {
    const client = stubClient(() => ({
      content: '{"tokens":["ai"]}',
    }));
    await classifyQuestion("Q?", ["yes", "no"], { client, model: "m" });

    const req = client.calls[0]!;
    expect(req.model).toBe("m");
    expect(req.temperature).toBe(0);
    expect(req.responseFormat).toEqual({ type: "json_object" });
    expect(req.messages[0]?.role).toBe("system");
    expect(req.messages[0]?.content).toContain("TAXONOMY");
    expect(req.messages[1]?.role).toBe("user");
    expect(JSON.parse(req.messages[1]!.content)).toEqual({
      question: "Q?",
      options: ["yes", "no"],
    });
  });

  it("fails closed on non-JSON model output (worker will leave row NULL)", async () => {
    const client = stubClient(() => ({ content: "Sure! Here you go: ai" }));
    const res = await classifyQuestion("q", ["yes", "no"], {
      client,
      model: "m",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/non-json-response/);
  });

  it("fails closed when no token in reply is in taxonomy", async () => {
    const client = stubClient(() => ({
      content: JSON.stringify({ tokens: ["hacking", "fashion"] }),
    }));
    const res = await classifyQuestion("q", ["yes", "no"], {
      client,
      model: "m",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/no-valid-tokens/);
  });

  it("fails closed when the HTTP call throws", async () => {
    const client: OpenRouterClient = {
      chat() {
        return Promise.reject(new Error("ECONNRESET"));
      },
    };
    const res = await classifyQuestion("q", ["yes", "no"], {
      client,
      model: "m",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/llm-call-failed/);
  });

  it("caps the topic count to 3 even if the model returns more", async () => {
    const client = stubClient(() => ({
      content: JSON.stringify({
        tokens: ["ai", "tech", "software", "coding"],
      }),
    }));
    const res = await classifyQuestion("q", ["yes", "no"], {
      client,
      model: "m",
    });
    if (!res.ok) throw new Error("expected ok");
    expect(res.topics).toEqual(["ai", "tech", "software"]);
  });

  it("truncates extremely long question text into the prompt", async () => {
    const client = stubClient(() => ({
      content: JSON.stringify({ tokens: ["ai"] }),
    }));
    const text = "a".repeat(10_000);
    await classifyQuestion(text, ["yes", "no"], { client, model: "m" });
    const payload = JSON.parse(client.calls[0]!.messages[1]!.content);
    expect(payload.question.length).toBeLessThanOrEqual(4_001 + 1);
    expect(payload.question.endsWith("…")).toBe(true);
  });
});
