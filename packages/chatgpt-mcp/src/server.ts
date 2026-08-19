import { createServer } from "node:http";
import type { ChorumOAuthServer } from "./oauth.js";

export type OAuthUserResolver = (request: import("node:http").IncomingMessage) => Promise<string | undefined>;

const tools = [
  { name: "chorum_authorize", description: "Obtain consent and begin Self identity authorization.", annotations: { readOnlyHint: false, destructiveHint: false }, inputSchema: { type: "object", properties: { consentAutomaticVoting: { type: "boolean" }, consentHistoryUse: { type: "boolean" } }, required: ["consentAutomaticVoting", "consentHistoryUse"] } },
  { name: "chorum_complete_identity", description: "Complete the pending Self identity authorization; the Self proof is collected server-side.", annotations: { readOnlyHint: false, destructiveHint: false }, inputSchema: { type: "object", properties: { state: { type: "string" } }, required: ["state"] } },
  { name: "chorum_latest_questions", description: "Retrieve the latest eligible Chorum questions.", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: {} } },
  { name: "chorum_vote", description: "Submit a grounded answer or abstain with answer null.", annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }, inputSchema: { type: "object", properties: { question_id: { type: "string" }, answer: { type: ["string", "null"] } }, required: ["question_id", "answer"] } },
  { name: "chorum_review", description: "Review this user's Chorum vote history.", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: {} } },
  { name: "chorum_revoke", description: "Revoke one previously submitted Chorum vote.", annotations: { readOnlyHint: false, destructiveHint: true }, inputSchema: { type: "object", properties: { question_id: { type: "string" } }, required: ["question_id"] } },
  { name: "chorum_reset", description: "Revoke and remove this user's Chorum authorization.", annotations: { readOnlyHint: false, destructiveHint: true }, inputSchema: { type: "object", properties: {} } },
];

const readOnlyTools = new Set(["chorum_authorize", "chorum_complete_identity", "chorum_latest_questions", "chorum_review"]);

/** Protocol shell only; production wiring must inject OAuth user resolution and service dependencies. */
export function createMcpServer(call: (userId: string, name: string, args: Record<string, unknown>) => Promise<unknown>, resolveUser: OAuthUserResolver = defaultLocalUserResolver, oauth?: ChorumOAuthServer) {
  return createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/mcp/healthz") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, read_only: process.env.CHORUM_MCP_READ_ONLY === "1", oauth_configured: Boolean(oauth) }));
      return;
    }
    if (req.method === "GET" && req.url === "/.well-known/oauth-protected-resource") {
      const resource = process.env.CHORUM_MCP_OAUTH_RESOURCE?.trim() || `${new URL(`http://${req.headers.host ?? "localhost"}`).origin}/mcp`;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(oauth ? oauth.protectedResourceMetadata() : { resource, authorization_servers: [] }));
      return;
    }
    if (req.method === "GET" && req.url === "/.well-known/oauth-authorization-server" && oauth) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(oauth.metadata()));
      return;
    }
    if (oauth && req.method === "GET" && req.url?.startsWith("/oauth/authorize?")) {
      await oauth.authorize(new URL(req.url, `http://${req.headers.host ?? "localhost"}`), res);
      return;
    }
    if (oauth && req.method === "POST" && req.url === "/oauth/consent") {
      let body = "";
      for await (const chunk of req) body += chunk;
      await oauth.consent(new URLSearchParams(body), res);
      return;
    }
    if (oauth && req.method === "POST" && req.url === "/oauth/register") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try { await oauth.register(JSON.parse(body), res); } catch { res.writeHead(400).end(); }
      return;
    }
    if (oauth && req.method === "GET" && req.url?.startsWith("/oauth/authorize/status?")) {
      await oauth.status(new URL(req.url, `http://${req.headers.host ?? "localhost"}`), res);
      return;
    }
    if (oauth && req.method === "POST" && req.url === "/oauth/token") {
      let body = "";
      for await (const chunk of req) body += chunk;
      await oauth.token(new URLSearchParams(body), res);
      return;
    }
    if (req.method !== "POST" || req.url !== "/mcp") { res.writeHead(404).end(); return; }
    const userId = await resolveUser(req);
    if (!userId) {
      const resource = process.env.CHORUM_MCP_OAUTH_RESOURCE?.trim();
      const metadata = resource ? `${new URL(resource).origin}/.well-known/oauth-protected-resource` : "/.well-known/oauth-protected-resource";
      res.writeHead(401, { "WWW-Authenticate": `Bearer resource_metadata=\"${metadata}\"` }).end();
      return;
    }
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
