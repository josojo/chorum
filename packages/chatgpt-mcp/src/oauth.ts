import { createHash, randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { ChorumService } from "./service.js";

type OAuthClient = { redirectUris: Set<string> };
type AuthorizationRequest = {
  clientId: string;
  redirectUri: string;
  resource: string;
  codeChallenge: string;
  state?: string;
  scope: string;
  temporaryUserId: string;
  selfUrl?: string;
  status: "consent" | "pending" | "complete";
  authorizationCode?: string;
  subject?: string;
};
type Code = { request: AuthorizationRequest; used: boolean };
type AccessToken = { userId: string; expiresAt: number; resource: string; scope: string };

const scope = "chorum.vote";
const tokenTtlSeconds = 900;
const b64url = (value: Buffer) => value.toString("base64url");
const digest = (value: string) => createHash("sha256").update(value).digest();
const html = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** Chorum OAuth server; Self.xyz remains the proof provider behind it. */
export class ChorumOAuthServer {
  private readonly clients = new Map<string, OAuthClient>();
  private readonly requests = new Map<string, AuthorizationRequest>();
  private readonly codes = new Map<string, Code>();
  private readonly tokens = new Map<string, AccessToken>();

  constructor(
    private readonly service: ChorumService,
    private readonly issuer: string,
    private readonly resource: string,
  ) {}

  metadata() {
    return {
      issuer: this.issuer,
      authorization_response_iss_parameter_supported: true,
      authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/oauth/token`,
      registration_endpoint: `${this.issuer}/oauth/register`,
      token_endpoint_auth_methods_supported: ["none"],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: [scope],
    };
  }

  protectedResourceMetadata() {
    return { resource: this.resource, authorization_servers: [this.issuer], scopes_supported: [scope] };
  }

  async register(body: unknown, res: ServerResponse): Promise<void> {
    const input = body as { redirect_uris?: unknown; token_endpoint_auth_method?: unknown; grant_types?: unknown; response_types?: unknown };
    const redirects = Array.isArray(input.redirect_uris) && input.redirect_uris.every((value) => typeof value === "string" && value.startsWith("https://"))
      ? input.redirect_uris as string[] : [];
    if (!redirects.length || (input.token_endpoint_auth_method && input.token_endpoint_auth_method !== "none")) {
      this.json(res, 400, { error: "invalid_client_metadata" });
      return;
    }
    const clientId = `chorum_${b64url(randomBytes(24))}`;
    this.clients.set(clientId, { redirectUris: new Set(redirects) });
    this.json(res, 201, { client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000), redirect_uris: redirects, token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] });
  }

  async authorize(url: URL, res: ServerResponse): Promise<void> {
    const clientId = url.searchParams.get("client_id") ?? "";
    const client = this.clients.get(clientId);
    const redirectUri = url.searchParams.get("redirect_uri");
    const challenge = url.searchParams.get("code_challenge");
    const responseType = url.searchParams.get("response_type");
    const requestedResource = url.searchParams.get("resource");
    const requestedScope = url.searchParams.get("scope") ?? scope;
    const state = url.searchParams.get("state") ?? undefined;
    if (!client || !redirectUri || !client.redirectUris.has(redirectUri) || responseType !== "code" || !challenge || url.searchParams.get("code_challenge_method") !== "S256" || requestedResource !== this.resource || requestedScope !== scope) {
      this.authorizationError(res, redirectUri && client?.redirectUris.has(redirectUri) ? redirectUri : undefined, state, "invalid_request");
      return;
    }
    const requestId = b64url(randomBytes(24));
    this.requests.set(requestId, { clientId, redirectUri, resource: this.resource, codeChallenge: challenge, state, scope, temporaryUserId: requestId, status: "consent" });
    this.renderConsent(res, requestId);
  }

  async consent(body: URLSearchParams, res: ServerResponse): Promise<void> {
    const requestId = body.get("request") ?? "";
    const request = this.requests.get(requestId);
    if (!request || request.status !== "consent") { res.writeHead(404).end(); return; }
    if (body.get("automatic_voting") !== "on" || body.get("history_use") !== "on") {
      this.authorizationError(res, request.redirectUri, request.state, "access_denied");
      return;
    }
    try {
      const started = await this.service.authorize(request.temporaryUserId, true, true);
      request.selfUrl = started.authorization_url;
      request.status = "pending";
      this.renderPending(res, requestId);
    } catch {
      this.authorizationError(res, request.redirectUri, request.state, "server_error");
    }
  }

  async status(url: URL, res: ServerResponse): Promise<void> {
    const requestId = url.searchParams.get("request") ?? "";
    const request = this.requests.get(requestId);
    if (!request) { res.writeHead(404).end(); return; }
    if (request.status === "pending") {
      try {
        const completed = await this.service.completeIdentity(request.temporaryUserId, requestId);
        request.subject = completed.subject;
        request.authorizationCode = b64url(randomBytes(32));
        this.codes.set(request.authorizationCode, { request, used: false });
        request.status = "complete";
      } catch (error) {
        if (error instanceof Error && !/could not be read|did not complete|missing or expired/.test(error.message)) {
          this.authorizationError(res, request.redirectUri, request.state, "server_error");
          return;
        }
      }
    }
    if (request.status === "complete" && request.authorizationCode) {
      const target = new URL(request.redirectUri);
      target.searchParams.set("code", request.authorizationCode);
      target.searchParams.set("iss", this.issuer);
      if (request.state) target.searchParams.set("state", request.state);
      res.writeHead(302, { location: target.toString() }).end();
      return;
    }
    this.renderPending(res, requestId);
  }

  async token(body: URLSearchParams, res: ServerResponse): Promise<void> {
    const codeValue = body.get("code");
    const entry = codeValue ? this.codes.get(codeValue) : undefined;
    const verifier = body.get("code_verifier");
    const client = body.get("client_id");
    const redirectUri = body.get("redirect_uri");
    if (!entry || entry.used || !verifier || client !== entry.request.clientId || redirectUri !== entry.request.redirectUri || body.get("resource") !== this.resource || b64url(digest(verifier)) !== entry.request.codeChallenge || !entry.request.subject) {
      this.json(res, 400, { error: "invalid_grant" });
      return;
    }
    entry.used = true;
    const token = b64url(randomBytes(32));
    this.tokens.set(token, { userId: entry.request.subject, expiresAt: Date.now() + tokenTtlSeconds * 1000, resource: this.resource, scope: entry.request.scope });
    this.json(res, 200, { access_token: token, token_type: "Bearer", expires_in: tokenTtlSeconds, scope: entry.request.scope });
  }

  resolveBearer(value: string): string | undefined {
    const entry = this.tokens.get(value);
    if (!entry || entry.expiresAt <= Date.now() || entry.resource !== this.resource) { this.tokens.delete(value); return undefined; }
    return entry.userId;
  }

  private renderConsent(res: ServerResponse, requestId: string) {
    const body = `<!doctype html><meta charset="utf-8"><title>Connect Chorum</title><h1>Connect Chorum</h1><p>Chorum will use your verified Self identity to access your account.</p><form method="post" action="/oauth/consent"><input type="hidden" name="request" value="${html(requestId)}"><label><input type="checkbox" name="automatic_voting"> Allow ongoing automatic voting</label><br><label><input type="checkbox" name="history_use"> Allow use of permitted past voting history</label><br><button type="submit">Continue to Self verification</button></form>`;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(body);
  }

  private renderPending(res: ServerResponse, requestId: string) {
    const request = this.requests.get(requestId)!;
    const statusUrl = `/oauth/authorize/status?request=${encodeURIComponent(requestId)}`;
    const body = `<!doctype html><meta charset="utf-8"><title>Verify with Self</title><p>Open Self to verify your identity. This page continues automatically after verification.</p><p><a href="${html(request.selfUrl ?? "")}">Open Self</a></p><meta http-equiv="refresh" content="3;url=${html(statusUrl)}">`;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(body);
  }

  private authorizationError(res: ServerResponse, redirectUri: string | undefined, state: string | undefined, error: string) {
    if (redirectUri) {
      const target = new URL(redirectUri);
      target.searchParams.set("error", error); target.searchParams.set("iss", this.issuer);
      if (state) target.searchParams.set("state", state);
      res.writeHead(302, { location: target.toString() }).end();
    } else this.json(res, 400, { error });
  }

  private json(res: ServerResponse, status: number, body: unknown) { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body)); }
}

export function pkceChallenge(verifier: string): string { return b64url(digest(verifier)); }
