// Pure-logic ports (no DB): rate limiter, production startup checks, scope
// eligibility, delegation expiry/signature, and the Self revocation log helpers.

import { describe, it, expect } from "vitest";

import { getSettings } from "../src/config";
import { RateLimiter } from "../src/ratelimit";
import {
  ProductionConfigError,
  enforceProductionConfig,
  validateProductionConfig,
} from "../src/startupChecks";
import { isScopeEligible } from "../src/eligibility";
import {
  AskerBlockReason,
  evaluateAskerEligibility,
  parseAdminIdentifiers,
} from "../src/askerGating";
import { VerifyDelegationError, verifyDelegation } from "../src/verify/delegation";
import { RejectionReason } from "../src/models";
import { extractNullifierFromLog, nullifierCandidates } from "../src/selfRevocations";
import { makeToken } from "./helpers";

describe("rate limiter (sliding window)", () => {
  it("admits up to the limit, then denies with a retry hint, then recovers", () => {
    let now = 1000;
    const limiter = new RateLimiter(
      { "POST /v1/register": { limit: 2, windowSeconds: 60 } },
      () => now,
    );
    expect(limiter.check("POST /v1/register", "ip1")[0]).toBe(true);
    expect(limiter.check("POST /v1/register", "ip1")[0]).toBe(true);
    const [allowed, retry] = limiter.check("POST /v1/register", "ip1");
    expect(allowed).toBe(false);
    expect(retry).toBeGreaterThan(0);
    // A different client is independent.
    expect(limiter.check("POST /v1/register", "ip2")[0]).toBe(true);
    // After the window elapses, ip1 is admitted again.
    now += 61;
    expect(limiter.check("POST /v1/register", "ip1")[0]).toBe(true);
  });

  it("passes through routes with no rule", () => {
    const limiter = new RateLimiter({}, () => 0);
    expect(limiter.check("GET /v1/questions/open", "ip1")).toEqual([true, 0]);
    expect(limiter.hasRule("GET /v1/questions/open")).toBe(false);
  });
});

describe("production startup checks", () => {
  it("flags every dev default as an error", () => {
    const report = validateProductionConfig(getSettings()); // all dev defaults
    // Dev defaults trip: signing key, dev DB password, expose-rejection-reasons.
    expect(report.errors.length).toBeGreaterThanOrEqual(3);
    expect(report.errors.some((e) => e.includes("HEARME_BROKER_SIGNING_KEY"))).toBe(true);
    expect(() => enforceProductionConfig(getSettings(), { warn() {}, info() {} })).toThrow(
      ProductionConfigError,
    );
  });

  it("accepts a properly secured config", () => {
    const safe = getSettings({
      brokerSigningKey: Buffer.alloc(32, 9).toString("base64"),
      databaseUrl: "postgres://hearme_broker:s3cret@db:5432/hearme",
      devInsecureRegister: false,
      requireRegistryConfirmation: true,
      exposeRejectionReasons: false,
      selfBridgeUrl: "http://self-bridge:8787",
    });
    const report = validateProductionConfig(safe);
    expect(report.errors).toEqual([]);
    expect(() => enforceProductionConfig(safe, { warn() {}, info() {} })).not.toThrow();
  });
});

describe("scope eligibility", () => {
  it("worldwide is always eligible", () => {
    expect(isScopeEligible({ question: { scope: "worldwide" }, disclosedPredicates: {} })).toBe(true);
  });
  it("country matches exactly", () => {
    const preds = { country: "DE", region: "EU" };
    expect(
      isScopeEligible({ question: { scope: "country", country: "DE", continent: "EU" }, disclosedPredicates: preds }),
    ).toBe(true);
    expect(
      isScopeEligible({ question: { scope: "country", country: "FR", continent: "EU" }, disclosedPredicates: preds }),
    ).toBe(false);
  });
  it("continent accepts the legacy region predicate", () => {
    expect(
      isScopeEligible({ question: { scope: "continent", continent: "EU" }, disclosedPredicates: { region: "EU" } }),
    ).toBe(true);
    expect(
      isScopeEligible({ question: { scope: "continent", continent: "AS" }, disclosedPredicates: { region: "EU" } }),
    ).toBe(false);
  });
});

describe("asker gating (unlock threshold, §15.3)", () => {
  const thresholds = { requiredTotal: 50, requiredSignal: 10 };
  const evalCounts = (total: number, signal: number, isAdmin = false) =>
    evaluateAskerEligibility({ counts: { total, signal }, thresholds, isAdmin });

  it("blocks below the total floor and reports how many remain", () => {
    const r = evalCounts(20, 5);
    expect(r.canAsk).toBe(false);
    expect(r.reason).toBe(AskerBlockReason.NOT_ENOUGH_ANSWERS);
    expect(r.remainingTotal).toBe(30);
    expect(r.remainingSignal).toBe(5);
  });

  it("unlocks exactly at both thresholds (boundary)", () => {
    const r = evalCounts(50, 10);
    expect(r.canAsk).toBe(true);
    expect(r.reason).toBeNull();
    expect(r.remainingTotal).toBe(0);
    expect(r.remainingSignal).toBe(0);
  });

  it("blocks one-short on either dimension", () => {
    expect(evalCounts(49, 10).reason).toBe(AskerBlockReason.NOT_ENOUGH_ANSWERS);
    expect(evalCounts(50, 9).reason).toBe(AskerBlockReason.NOT_ENOUGH_SIGNAL);
  });

  it("enough total but too few signal-bearing fails the anti-farming clause", () => {
    // 60 answers but only 3 carried signal — the no-signal farm (§15.4).
    const r = evalCounts(60, 3);
    expect(r.canAsk).toBe(false);
    expect(r.reason).toBe(AskerBlockReason.NOT_ENOUGH_SIGNAL);
    expect(r.remainingTotal).toBe(0);
    expect(r.remainingSignal).toBe(7);
  });

  it("admins bypass the threshold entirely (bootstrap valve)", () => {
    const r = evalCounts(0, 0, true);
    expect(r.canAsk).toBe(true);
    expect(r.isAdmin).toBe(true);
    expect(r.reason).toBeNull();
    expect(r.remainingTotal).toBe(0);
    expect(r.remainingSignal).toBe(0);
  });

  it("parses the admin allowlist from comma/space separated config", () => {
    const set = parseAdminIdentifiers(" id-a, id-b\nid-c ,, ");
    expect(set.has("id-a")).toBe(true);
    expect(set.has("id-b")).toBe(true);
    expect(set.has("id-c")).toBe(true);
    expect(set.size).toBe(3);
    expect(parseAdminIdentifiers("").size).toBe(0);
  });
});

describe("delegation verification", () => {
  it("accepts a fresh token and returns its hash", () => {
    const v = verifyDelegation(makeToken());
    expect(v.delegationHash).toMatch(/^[0-9a-f]{64}$/);
    expect(v.uniqueIdentifier).toContain("self:");
  });
  it("rejects an expired token", () => {
    const tok = makeToken({
      issuedAt: new Date(Date.now() - 100 * 86400_000),
      expiresAt: new Date(Date.now() - 86400_000),
    });
    try {
      verifyDelegation(tok);
      expect.unreachable();
    } catch (e) {
      expect((e as VerifyDelegationError).reason).toBe(RejectionReason.TOKEN_EXPIRED);
    }
  });
  it("rejects a tampered token", () => {
    const tok = { ...makeToken(), unique_identifier: "self:evil" };
    try {
      verifyDelegation(tok);
      expect.unreachable();
    } catch (e) {
      expect((e as VerifyDelegationError).reason).toBe(RejectionReason.BROKER_SIGNATURE_INVALID);
    }
  });
});

describe("self revocation log helpers", () => {
  it("derives the candidate nullifier forms", () => {
    const cands = nullifierCandidates("0x0000000000000000000000000000000000000000000000000000000000000010");
    expect(cands).toContain("0x10");
    expect(cands).toContain("16");
    expect(cands).toContain("self:16");
  });
  it("extracts a nullifier from an indexed topic", () => {
    const nul = extractNullifierFromLog(
      { topics: ["0xevent", "0x00000000000000000000000000000000000000000000000000000000000000ab"] },
      1,
      -1,
    );
    expect(nul).toBe("0x00000000000000000000000000000000000000000000000000000000000000ab");
  });
  it("extracts a nullifier from a data word", () => {
    const word = "f".repeat(64);
    const nul = extractNullifierFromLog({ topics: ["0xevent"], data: `0x${word}` }, -1, 0);
    expect(nul).toBe(`0x${word}`);
  });
});
