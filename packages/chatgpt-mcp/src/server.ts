import { createServer } from "node:http";

export type OAuthUserResolver = (request: import("node:http").IncomingMessage) => Promise<string | undefined>;

const tools = [
  { name: "chorum_authorize", description: "Obtain consent and begin Self identity authorization.", inputSchema: { type: "object", properties: { consentAutomaticVoting: { type: "boolean" }, consentHistoryUse: { type: "boolean" } }, required: ["consentAutomaticVoting", "consentHistoryUse"] } },
  { name: "chorum_complete_identity", description: "Complete the pending Self identity authorization; the Self proof is collected server-side.", inputSchema: { type: "object", properties: { state: { type: "string" } }, required: ["state"] } },
  { name: "chorum_latest_questions", description: "Retrieve the latest eligible Chorum questions.", inputSchema: { type: "object", properties: {} } },
  { name: "chorum_vote", description: "Submit a grounded answer or abstain with answer null.", inputSchema: { type: "object", properties: { question_id: { type: "string" }, answer: { type: ["string", "null"] } }, required: ["question_id", "answer"] } },
  { name: "chorum_review", description: "Review this user's Chorum vote history.", inputSchema: { type: "object", properties: {} } },
  { name: "chorum_revoke", description: "Revoke one previously submitted Chorum vote.", inputSchema: { type: "object", properties: { question_id: { type: "string" } }, required: ["question_id"] } },
  { name: "chorum_reset", description: "Revoke and remove this user's Chorum authorization.", inputSchema: { type: "object", properties: {} } },
];

const readOnlyTools = new Set(["chorum_authorize", "chorum_complete_identity", "chorum_latest_questions", "chorum_review"]);

/** Protocol shell only; production wiring must inject OAuth user resolution and service dependencies. */
export function createMcpServer(call: (userId: string, name: string, args: Record<string, unknown>) => Promise<unknown>, resolveUser: OAuthUserResolver = defaultLocalUserResolver) {
  return createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/mcp/healthz") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, read_only: process.env.CHORUM_MCP_READ_ONLY === "1", oauth_configured: process.env.CHORUM_MCP_AUTH_CONFIGURED === "1" }));
      return;
    }
    if (req.method === "GET" && req.url === "/.well-known/oauth-protected-resource") {
      const issuer = process.env.CHORUM_MCP_OAUTH_ISSUER?.trim();
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ resource: "/mcp", authorization_servers: issuer ? [issuer] : [], oauth_configured: Boolean(issuer) }));
      return;
    }
    if (req.method !== "POST" || req.url !== "/mcp") { res.writeHead(404).end(); return; }
    const userId = await resolveUser(req);
    if (!userId) { res.writeHead(401, { "WWW-Authenticate": "Bearer" }).end(); return; }
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body) as { id: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    try {
      let result: unknown;
      if (request.method === "initialize") result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "chorum", version: "0.1.0" } };
      else if (request.method === "tools/list") result = { tools: process.env.CHORUM_MCP_READ_ONLY === "1" ? tools.filter((tool) => readOnlyTools.has(tool.name)) : tools };
      else if (request.method === "tools/call" && request.params?.name) {
        if (process.env.CHORUM_MCP_READ_ONLY === "1" && !readOnlyTools.has(request.params.name)) throw new Error("tool disabled in read-only staging mode");
        result = { content: [{ type: "text", text: JSON.stringify(await call(userId, request.params.name, request.params.arguments ?? {})) }] };
      }
      else throw new Error("unsupported MCP method");
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
    } catch (error) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: error instanceof Error ? error.message : "request failed" } }));
    }
  });
}

async function defaultLocalUserResolver(req: import("node:http").IncomingMessage) {
  if (process.env.NODE_ENV === "production") return undefined;
  const auth = req.headers.authorization;
  return auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
}

export function localMasterKey(): Buffer {
  const raw = process.env.CHORUM_MCP_MASTER_KEY_B64;
  if (!raw) throw new Error("CHORUM_MCP_MASTER_KEY_B64 is required");
  return Buffer.from(raw, "base64");
}

if (process.env.CHORUM_MCP_RUN_SERVER === "1") {
  const server = createMcpServer(async () => ({ status: "not-configured" }));
  server.listen(Number(process.env.PORT ?? 8788));
}
