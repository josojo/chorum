// Tests for the asker session cookie (lib/self-session.ts): a signed token is
// minted from a Self nullifier, round-trips, rejects tampering, hides the raw
// nullifier, and expires.

import { describe, it, expect } from "vitest";
import {
  sign,
  verify,
  pseudonym,
  SESSION_MAX_AGE,
} from "../src/lib/self-session";

describe("self-session", () => {
  const nullifier = "self-nullifier-abc-123";

  it("signs a token that verifies", () => {
    const token = sign(nullifier);
    const r = verify(token);
    expect(r.valid).toBe(true);
    expect(r.session?.sub).toBe(pseudonym(nullifier));
  });

  it("never embeds the raw nullifier in the token", () => {
    const token = sign(nullifier);
    expect(token).not.toContain(nullifier);
    const body = Buffer.from(token.split(".")[0], "base64url").toString("utf8");
    expect(body).not.toContain(nullifier);
  });

  it("rejects a tampered payload", () => {
    const token = sign(nullifier);
    const [, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "evil", iat: 0, exp: 9_999_999_999 }))
      .toString("base64url");
    expect(verify(`${forged}.${sig}`).valid).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const token = sign(nullifier);
    expect(verify(token.slice(0, -1) + (token.endsWith("A") ? "B" : "A")).valid).toBe(false);
  });

  it("rejects empty / malformed input", () => {
    expect(verify(undefined).valid).toBe(false);
    expect(verify("").valid).toBe(false);
    expect(verify("no-dot").valid).toBe(false);
  });

  it("rejects an expired token", () => {
    const t0 = 1_000_000_000_000;
    const token = sign(nullifier, t0);
    // Just past expiry.
    const later = t0 + (SESSION_MAX_AGE + 1) * 1000;
    expect(verify(token, later).valid).toBe(false);
    // Still valid just before.
    expect(verify(token, t0 + 1000).valid).toBe(true);
  });

  it("derives a stable, non-reversible pseudonym", () => {
    expect(pseudonym(nullifier)).toBe(pseudonym(nullifier));
    expect(pseudonym(nullifier)).not.toBe(pseudonym("other"));
    expect(pseudonym(nullifier)).not.toContain(nullifier);
  });
});
