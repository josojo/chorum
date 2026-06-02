// Tests for the asker-auth broker client (the web side of the §14.2 gate).
//
// We stub global.fetch so no broker is needed. The contract under test:
//   - malformed JSON never hits the network
//   - an authorized + can_ask identity yields ok:true with the verified id
//   - an unauthorized token, a blocked (under-threshold) identity, and an
//     unreachable broker each yield a distinct ok:false code + a friendly message

import { describe, it, expect, vi, afterEach } from "vitest";
import { checkAskerEligibility, checkAskerSession } from "../src/lib/asker-auth";

const VALID_TOKEN = JSON.stringify({ version: 2, scope: "hearme-v1" });

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  global.fetch = fn as any;
  return fn;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("checkAskerEligibility", () => {
  it("rejects malformed JSON without touching the network", async () => {
    const fn = mockFetch(200, {});
    const r = await checkAskerEligibility("not json{");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("parse");
    expect(fn).not.toHaveBeenCalled();
  });

  it("returns the verified identity when authorized and over the threshold", async () => {
    mockFetch(200, {
      authorized: true,
      auth_reason: null,
      unique_identifier: "self:asker-1",
      can_ask: true,
      is_admin: false,
      total_answers: 50,
      signal_answers: 10,
      required_total: 50,
      required_signal: 10,
      remaining_total: 0,
      remaining_signal: 0,
      reason: null,
    });
    const r = await checkAskerEligibility(VALID_TOKEN);
    expect(r).toEqual({ ok: true, uniqueIdentifier: "self:asker-1" });
  });

  it("blocks an authenticated-but-under-threshold identity with a nudge", async () => {
    mockFetch(200, {
      authorized: true,
      auth_reason: null,
      unique_identifier: "self:asker-2",
      can_ask: false,
      is_admin: false,
      total_answers: 20,
      signal_answers: 5,
      required_total: 50,
      required_signal: 10,
      remaining_total: 30,
      remaining_signal: 5,
      reason: "not_enough_answers",
    });
    const r = await checkAskerEligibility(VALID_TOKEN);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("blocked");
      expect(r.message).toContain("30 more");
    }
  });

  it("guides a signal-short farmer to opinion-bearing answers", async () => {
    mockFetch(200, {
      authorized: true,
      auth_reason: null,
      unique_identifier: "self:farm",
      can_ask: false,
      is_admin: false,
      total_answers: 60,
      signal_answers: 3,
      required_total: 50,
      required_signal: 10,
      remaining_total: 0,
      remaining_signal: 7,
      reason: "not_enough_signal",
    });
    const r = await checkAskerEligibility(VALID_TOKEN);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("blocked");
      expect(r.message).toContain("7 more");
      expect(r.message).toContain("real opinion");
    }
  });

  it("maps an unauthorized token to a credential message", async () => {
    mockFetch(200, {
      authorized: false,
      auth_reason: "registration_not_found",
      unique_identifier: null,
      can_ask: false,
      is_admin: false,
      total_answers: 0,
      signal_answers: 0,
      required_total: 50,
      required_signal: 10,
      remaining_total: 50,
      remaining_signal: 10,
      reason: null,
    });
    const r = await checkAskerEligibility(VALID_TOKEN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unauthorized");
  });

  it("fails closed when the broker is unreachable", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    global.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as any;
    const r = await checkAskerEligibility(VALID_TOKEN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("broker_unreachable");
  });

  it("treats a 422 as a malformed credential", async () => {
    mockFetch(422, { detail: [] });
    const r = await checkAskerEligibility(VALID_TOKEN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("parse");
  });
});

describe("checkAskerSession", () => {
  const VALID_SESSION = JSON.stringify({ version: 1, kind: "asker_session" });

  it("rejects malformed JSON without touching the network", async () => {
    const fn = mockFetch(200, {});
    const r = await checkAskerSession("not json{");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("parse");
    expect(fn).not.toHaveBeenCalled();
  });

  it("returns the verified identity for an authorized, cleared session", async () => {
    const fn = mockFetch(200, {
      authorized: true,
      auth_reason: null,
      unique_identifier: "self:login-1",
      can_ask: true,
      is_admin: false,
      total_answers: 60,
      signal_answers: 12,
      required_total: 50,
      required_signal: 10,
      remaining_total: 0,
      remaining_signal: 0,
      reason: null,
    });
    const r = await checkAskerSession(VALID_SESSION);
    expect(r).toEqual({ ok: true, uniqueIdentifier: "self:login-1" });
    // It hits the session endpoint, not the token one.
    expect(fn).toHaveBeenCalledWith(
      expect.stringContaining("/v1/askers/session/verify"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("maps an expired session to an unauthorized result", async () => {
    mockFetch(200, {
      authorized: false,
      auth_reason: "token_expired",
      unique_identifier: null,
      can_ask: false,
      is_admin: false,
      total_answers: 0,
      signal_answers: 0,
      required_total: 50,
      required_signal: 10,
      remaining_total: 50,
      remaining_signal: 10,
      reason: null,
    });
    const r = await checkAskerSession(VALID_SESSION);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unauthorized");
  });
});
