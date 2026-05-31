// Minimal OpenRouter chat-completions client.
//
// Why hand-rolled and not the openai SDK: the request shape we need is one
// JSON POST with three fields (model, messages, response_format) and one
// header (Authorization). Pulling in the SDK and its transitive deps just to
// avoid 30 lines of fetch is the wrong trade for a Docker image.
//
// OpenRouter docs: https://openrouter.ai/docs/api-reference/overview

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ChatCompletionRequest = {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  // OpenRouter supports OpenAI-style structured output. We always set
  // type: "json_object" so the assistant message is guaranteed parseable JSON
  // — never a markdown-wrapped fence or a polite prefix.
  responseFormat?: { type: "json_object" };
  maxTokens?: number;
};

export type ChatCompletionResponse = {
  // First choice's assistant message content. Always a string; for json_object
  // responses, this string is the JSON document — caller still has to JSON.parse.
  content: string;
};

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly body: string | null,
  ) {
    super(message);
    this.name = "OpenRouterError";
  }
}

export type OpenRouterClient = {
  chat(req: ChatCompletionRequest): Promise<ChatCompletionResponse>;
};

export type OpenRouterClientOptions = {
  apiKey: string;
  baseUrl?: string;
  // Hard timeout (ms) for the underlying fetch. We don't retry inside this
  // client — that's the worker's job (next poll re-tries naturally).
  timeoutMs?: number;
  // Optional fetch override for tests.
  fetchImpl?: typeof fetch;
  // OpenRouter recommends an HTTP-Referer / X-Title pair for usage attribution.
  referer?: string;
  title?: string;
};

export function createOpenRouterClient(
  opts: OpenRouterClientOptions,
): OpenRouterClient {
  const baseUrl = opts.baseUrl ?? "https://openrouter.ai/api/v1";
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const fetchImpl = opts.fetchImpl ?? fetch;

  return {
    async chat(req) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let resp: Response;
      try {
        resp = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: "POST",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            "Content-Type": "application/json",
            ...(opts.referer ? { "HTTP-Referer": opts.referer } : {}),
            ...(opts.title ? { "X-Title": opts.title } : {}),
          },
          body: JSON.stringify({
            model: req.model,
            messages: req.messages,
            ...(req.temperature !== undefined
              ? { temperature: req.temperature }
              : {}),
            ...(req.responseFormat
              ? { response_format: req.responseFormat }
              : {}),
            ...(req.maxTokens !== undefined
              ? { max_tokens: req.maxTokens }
              : {}),
          }),
        });
      } catch (err) {
        clearTimeout(timer);
        const msg = err instanceof Error ? err.message : String(err);
        throw new OpenRouterError(`fetch failed: ${msg}`, null, null);
      }
      clearTimeout(timer);

      const text = await resp.text();
      if (!resp.ok) {
        throw new OpenRouterError(
          `HTTP ${resp.status}`,
          resp.status,
          text.slice(0, 500),
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new OpenRouterError(
          "response body is not JSON",
          resp.status,
          text.slice(0, 500),
        );
      }
      const content = extractContent(parsed);
      if (content === null) {
        throw new OpenRouterError(
          "no assistant content in response",
          resp.status,
          JSON.stringify(parsed).slice(0, 500),
        );
      }
      return { content };
    },
  };
}

// OpenAI/OpenRouter shape: { choices: [ { message: { content: "..." } } ] }.
// Permissive — accept either string content or the array-of-parts variant
// some providers return.
function extractContent(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object") return null;
  const choices = (parsed as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!first || typeof first !== "object") return null;
  const message = (first as { message?: unknown }).message;
  if (!message || typeof message !== "object") return null;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    // OpenAI multi-part: [{type:'text', text:'...'}]
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (
          part &&
          typeof part === "object" &&
          typeof (part as { text?: unknown }).text === "string"
        ) {
          return (part as { text: string }).text;
        }
        return "";
      })
      .join("");
  }
  return null;
}
