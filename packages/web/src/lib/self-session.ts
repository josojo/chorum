// Asker session — a signed, HttpOnly cookie minted after a successful Self
// verification on the web (see app/api/ask-verify/*). It gates question
// creation (actions/create-question.ts).
//
// Server-only (uses node:crypto + a server secret); never import from a client
// component. The cookie payload carries a *pseudonym* derived from the Self
// nullifier — HMAC(nullifier, secret) — never the raw nullifier, which is
// sensitive and links a person's activity (ARCHITECTURE.md §1.4). The pseudonym
// is enough to tie the session to one human without leaking the nullifier to the
// browser.

import crypto from "node:crypto";

// Dev default mirrors the repo's other dev secrets; the staging/prod overlays
// MUST override it (a stable key is required so sessions survive web restarts).
const SECRET = process.env.HEARME_WEB_SESSION_SECRET || "hearme_web_session_dev";

export const SESSION_COOKIE = "hearme_asker";
export const SESSION_MAX_AGE = 24 * 60 * 60; // seconds

export type Session = { sub: string; iat: number; exp: number };

function hmac(data: string): string {
  return crypto.createHmac("sha256", SECRET).update(data).digest("base64url");
}

/** Stable per-human pseudonym for a Self nullifier (never store the raw value). */
export function pseudonym(nullifier: string): string {
  return hmac("nullifier:" + nullifier);
}

/** Mint a signed session token for a verified nullifier. */
export function sign(nullifier: string, now: number = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const payload: Session = { sub: pseudonym(nullifier), iat, exp: iat + SESSION_MAX_AGE };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${hmac(body)}`;
}

/** Verify a cookie value: signature must match and the token must be unexpired. */
export function verify(
  value: string | undefined | null,
  now: number = Date.now(),
): { valid: boolean; session?: Session } {
  if (!value) return { valid: false };
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return { valid: false };
  const body = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const expected = hmac(body);
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return { valid: false };
  }
  let session: Session;
  try {
    session = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { valid: false };
  }
  if (typeof session?.exp !== "number" || session.exp * 1000 < now) {
    return { valid: false };
  }
  return { valid: true, session };
}
