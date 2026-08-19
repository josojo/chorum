import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EncryptedUserStore } from "../src/store.js";
import { ChorumService } from "../src/service.js";
import { ChorumOAuthServer, pkceChallenge } from "../src/oauth.js";

test("requires both explicit consents and keeps credentials encrypted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chorum-mcp-"));
  const path = join(dir, "users.enc");
  const store = new EncryptedUserStore(path, Buffer.alloc(32, 7));
  const identity = { begin: async () => ({ authorizationUrl: "https://self.test/a", state: "s1" }), complete: async () => ({ delegation_token: { secret: "token" }, agent_seed_b64: "seed" }) };
  const broker = { latestQuestions: async () => [{ question_id: "q1", text: "Tea?", options: ["yes", "no"] }], review: async () => ({ answers: [] }) };
  const signer = { submit: async (_u: string, _c: unknown, _q: string, answer: string | null) => ({ accepted: answer === null, reason: answer === null ? "abstained" : "ok" }), revoke: async () => ({ accepted: true }), revokeAll: async () => {}, review: async () => ({ answers: [] }) };
  const service = new ChorumService(store, identity, broker, signer);
  await assert.rejects(service.authorize("u1", true, false));
  assert.deepEqual(await service.authorize("u1", true, true), { status: "identity_authorization_required", authorization_url: "https://self.test/a" });
  await service.completeIdentity("u1", "s1");
  assert.deepEqual(await service.latestQuestions("u1"), [{ question_id: "q1", text: "Tea?", options: ["yes", "no"] }]);
  assert.deepEqual(await service.vote("u1", "q1", null), { accepted: true, reason: "abstained" });
  assert.equal((await readFile(path, "utf8")).includes("token"), false);
  await service.reset("u1");
  await assert.rejects(service.latestQuestions("u1"));
});

test("OAuth binds a one-use PKCE code to the verified Self subject", async () => {
  const service = {
    authorize: async () => ({ status: "identity_authorization_required", authorization_url: "https://self.test/request" }),
    completeIdentity: async () => ({ status: "authorized", subject: "self:nullifier" }),
  } as unknown as ChorumService;
  const oauth = new ChorumOAuthServer(service, "https://chorum.test", "https://chorum.test/mcp");
  const verifier = "a-secure-pkce-verifier";
  let location = "";
  let body = "";
  const response = () => ({
    writeHead: (_status: number, headers?: Record<string, string>) => { location = headers?.location ?? ""; return response(); },
    end: (value?: string) => { body = value ?? ""; return response(); },
  }) as never;
  await oauth.register({ redirect_uris: ["https://chatgpt.test/callback"], token_endpoint_auth_method: "none" }, response());
  const clientId = JSON.parse(body).client_id as string;
  const authorizeUrl = new URL("https://chorum.test/oauth/authorize?client_id=" + encodeURIComponent(clientId) + "&redirect_uri=https%3A%2F%2Fchatgpt.test%2Fcallback&response_type=code&resource=https%3A%2F%2Fchorum.test%2Fmcp&scope=chorum.vote&code_challenge_method=S256&code_challenge=" + encodeURIComponent(pkceChallenge(verifier)) + "&state=xyz");
  await oauth.authorize(authorizeUrl, response());
  const encodedRequest = /name="request" value="([^"]+)"/.exec(body)?.[1];
  const request = encodedRequest;
  assert.ok(request);
  await oauth.consent(new URLSearchParams({ request, automatic_voting: "on", history_use: "on" }), response());
  await oauth.status(new URL(`https://chorum.test/oauth/authorize/status?request=${request}`), response());
  const code = new URL(location).searchParams.get("code");
  assert.ok(code);
  let tokenBody = "";
  const tokenResponse = {
    writeHead: (_status: number) => tokenResponse,
    end: (body?: string) => { tokenBody = body ?? ""; return tokenResponse; },
  } as never;
  await oauth.token(new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: "https://chatgpt.test/callback", resource: "https://chorum.test/mcp", code_verifier: verifier }), tokenResponse);
  const token = JSON.parse(tokenBody).access_token as string;
  assert.equal(oauth.resolveBearer(token), "self:nullifier");
  await oauth.token(new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: "https://chatgpt.test/callback", resource: "https://chorum.test/mcp", code_verifier: verifier }), tokenResponse);
  assert.equal(JSON.parse(tokenBody).error, "invalid_grant");
});
