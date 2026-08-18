import { createHash, randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { ChorumService } from "./service.js";

type AuthorizationRequest = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scope: string;
  temporaryUserId: string;
  selfUrl: string;
  status: "pending" | "complete";
  authorizationCode?: string;
  subject?: string;
};

type Code = { request: AuthorizationRequest; used: boolean };
type AccessToken = { userId: string; expiresAt: number };

const ttlSeconds = 300;
const tokenTtlSeconds = 900;
const b64url = (value: Buffer) => value.toString("base64url");
const digest = (value: string) => createHash("sha256").update(value).digest();
const html = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/**
 * Chorum's OAuth server. Self.xyz is intentionally a proof provider behind
 * this boundary, not an OAuth issuer: the browser completes a Self proof,
 * then Chorum mints a short-lived PKCE-bound authorization code and bearer
 * token. Credential material remains in ChorumService's encrypted store.
 */
export class ChorumOAuthServer {
  private readonly requests = new Map<string, AuthorizationRequest>();
  private readonly codes = new Map<string, Code>();
  private readonly tokens = new Map<string, AccessToken>();

  constructor(
    private readonly service: ChorumService,
    private readonly issuer: string,
    private readonly clientId: string,
    private readonly redirectUris: Set<string>,
  ) {}

  metadata() {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/oauth/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["chorum.read"],
    };
  }

  async authorize(url: URL, res: ServerResponse): Promise<void> {
    const clientId = url.searchParams.get("client_id");
    const redirectUri = url.searchParams.get("redirect_uri");
    const challenge = url.searchParams.get("code_challenge");
    const responseType = url.searchParams.get("response_type");
    const state = url.searchParams.get("state") ?? undefined;
    const scope = url.searchParams.get("scope") ?? "chorum.read";
    if (clientId !== this.clientId || responseType !== "code" || !redirectUri || !this.redirectUris.has(redirectUri) || !challenge || scope !== "chorum.read") {
      res.writeHead(400, { "content-type": "text/plain" }).end("invalid OAuth authorization request");
      return;
    }
    const requestId = b64url(randomBytes(24));
    const started = await this.service.authorize(requestId, true, true);
    this.requests.set(requestId, {
      clientId, redirectUri, codeChallenge: challenge, state, scope,
      temporaryUserId: requestId, selfUrl: started.authorization_url,
      status: "pending",
    });
    this.renderPending(res, requestId);
  }

  async status(url: URL, res: ServerResponse): Promise<void> {
    const requestId = url.searchParams.get("request");
    const request = requestId ? this.requests.get(requestId) : undefined;
    if (!request) { res.writeHead(404).end(); return; }
    if (request.status === "pending") {
      try {
        const completed = await this.service.completeIdentity(request.temporaryUserId, requestId!);
        request.subject = completed.subject;
        const code = b64url(randomBytes(32));
        this.codes.set(code, { request, used: false });
        request.authorizationCode = code;
        request.status = "complete";
      } catch (error) {
        // The Self bridge reports an incomplete request while the scan is in
        // progress. Keep polling; terminal errors are surfaced without logs.
        if (error instanceof Error && !/could not be read|did not complete|missing or expired/.test(error.message)) {
          res.writeHead(400, { "content-type": "text/plain" }).end("Self authorization failed");
          return;
        }
      }
    }
    if (request.status === "complete" && request.authorizationCode) {
      const target = new URL(request.redirectUri);
      target.searchParams.set("code", request.authorizationCode);
      if (request.state) target.searchParams.set("state", request.state);
      res.writeHead(302, { location: target.toString() }).end();
      return;
    }
    this.renderPending(res, requestId!);
  }

  async token(body: URLSearchParams, res: ServerResponse): Promise<void> {
    const codeValue = body.get("code");
    const verifier = body.get("code_verifier");
    const entry = codeValue ? this.codes.get(codeValue) : undefined;
    if (!entry || entry.used || !verifier || b64url(digest(verifier)) !== entry.request.codeChallenge) {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_grant" }));
      return;
    }
    entry.used = true;
    const token = b64url(randomBytes(32));
    // The temporary record was atomically moved to the Self nullifier by
    // completeIdentity; resolve it once and retain only the opaque token map.
    if (!entry.request.subject) {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_grant" }));
      return;
    }
    this.tokens.set(token, { userId: entry.request.subject, expiresAt: Date.now() + tokenTtlSeconds * 1000 });
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ access_token: token, token_type: "Bearer", expires_in: tokenTtlSeconds, scope: entry.request.scope }));
  }

  resolveBearer(value: string): string | undefined {
    const entry = this.tokens.get(value);
    if (!entry || entry.expiresAt <= Date.now()) { this.tokens.delete(value); return undefined; }
    return entry.userId;
  }

  private renderPending(res: ServerResponse, requestId: string) {
    const request = this.requests.get(requestId)!;
    const statusUrl = `/oauth/authorize/status?request=${encodeURIComponent(requestId)}`;
    const body = `<!doctype html><meta charset="utf-8"><title>Connect Chorum</title><p>Open Self to verify your identity. This page will continue automatically after verification.</p><p><a href="${html(request.selfUrl)}">Open Self</a></p><meta http-equiv="refresh" content="3;url=${html(statusUrl)}">`;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(body);
  }
}

export function pkceChallenge(verifier: string): string { return b64url(digest(verifier)); }
