// HTTP-layer tests: build a fake fetch implementation, assert the request
// shape and the response parsing. No network calls.

import { describe, it, expect } from "vitest";
import {
  createOpenRouterClient,
  OpenRouterError,
} from "../src/openrouter.js";

type Capture = {
  url: string | URL | Request;
  init: RequestInit | undefined;
};

function stubFetch(response: Response | (() => Response | Promise<Response>)) {
  const calls: Capture[] = [];
  const impl: typeof fetch = async (url, init) => {
    calls.push({ url, init });
    return typeof response === "function" ? response() : response;
  };
  return { impl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createOpenRouterClient", () => {
  it("POSTs to /chat/completions with bearer auth and the documented body", async () => {
    const { impl, calls } = stubFetch(
      jsonResponse({
        choices: [{ message: { content: '{"tokens":["ai"]}' } }],
      }),
    );
    const client = createOpenRouterClient({
      apiKey: "sk-or-test",
      fetchImpl: impl,
      referer: "https://hearme.network",
      title: "hearme-classifier",
    });

    const resp = await client.chat({
      model: "test/model",
      messages: [{ role: "user", content: "x" }],
      temperature: 0,
      responseFormat: { type: "json_object" },
      maxTokens: 64,
    });

    expect(resp.content).toBe('{"tokens":["ai"]}');
    expect(calls.length).toBe(1);

    const c = calls[0]!;
    expect(String(c.url)).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(c.init?.method).toBe("POST");
    const headers = new Headers(c.init?.headers as HeadersInit | undefined);
    expect(headers.get("Authorization")).toBe("Bearer sk-or-test");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("HTTP-Referer")).toBe("https://hearme.network");
    expect(headers.get("X-Title")).toBe("hearme-classifier");

    const body = JSON.parse(String(c.init?.body));
    expect(body).toEqual({
      model: "test/model",
      messages: [{ role: "user", content: "x" }],
      temperature: 0,
      response_format: { type: "json_object" },
      max_tokens: 64,
    });
  });

  it("throws OpenRouterError on non-2xx", async () => {
    const { impl } = stubFetch(jsonResponse({ error: "nope" }, 503));
    const client = createOpenRouterClient({ apiKey: "k", fetchImpl: impl });

    await expect(
      client.chat({ model: "m", messages: [{ role: "user", content: "" }] }),
    ).rejects.toMatchObject({
      name: "OpenRouterError",
      status: 503,
    });
  });

  it("throws OpenRouterError when body is not JSON", async () => {
    const { impl } = stubFetch(
      new Response("not json", { status: 200, headers: { "Content-Type": "text/plain" } }),
    );
    const client = createOpenRouterClient({ apiKey: "k", fetchImpl: impl });

    await expect(
      client.chat({ model: "m", messages: [{ role: "user", content: "" }] }),
    ).rejects.toThrow(OpenRouterError);
  });

  it("supports multi-part content arrays", async () => {
    const { impl } = stubFetch(
      jsonResponse({
        choices: [
          {
            message: {
              content: [
                { type: "text", text: "{\"tokens\":[" },
                { type: "text", text: "\"ai\"]}" },
              ],
            },
          },
        ],
      }),
    );
    const client = createOpenRouterClient({ apiKey: "k", fetchImpl: impl });
    const resp = await client.chat({
      model: "m",
      messages: [{ role: "user", content: "" }],
    });
    expect(resp.content).toBe('{"tokens":["ai"]}');
  });
});
