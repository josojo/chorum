// DB-backed ports: the full verify→persist→aggregate→revoke pipeline against a
// real Postgres (testcontainers). Skipped gracefully when Docker is unavailable
// (CI runs them). Mirrors test_register / test_uniqueness / test_aggregate_recompute
// / test_revocations / test_stats / test_dev_register / test_e2e_dev_bypass.

import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { type Db } from "../src/db";
import type { DelegationToken } from "../src/models";
import type {
  CreateSelfRequest,
  GetSelfRequest,
} from "../src/verify/bridgeClient";
import {
  ASKER_SESSION_TTL_MS,
  issueAskerSession,
} from "../src/verify/askerSession";
import { startPg, truncateAll, type PgHandle } from "./pg";
import { agentKeyB64, makeEnvelope, makeRevocation, makeEnrollment, makeToken, mockVerifyProof } from "./helpers";
import * as q from "../src/queries";

let pg: PgHandle | null = null;
let db: Db;
let app: FastifyInstance;

// Swappable self-bridge mocks for the "Sign in with Self" login routes. Tests
// set these per-case; default to throwing so an unconfigured call is loud.
let selfRequestImpl: CreateSelfRequest = async () => {
  throw new Error("createSelfRequest not configured for this test");
};
let selfStatusImpl: GetSelfRequest = async () => {
  throw new Error("getSelfRequest not configured for this test");
};

beforeAll(async () => {
  process.env.HEARME_BROKER_RATELIMIT_ENABLED = "0";
  process.env.HEARME_BROKER_DEV_INSECURE_REGISTER = "1";
  try {
    pg = await startPg();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[db.test] skipping — Docker unavailable: ${err}`);
    return;
  }
  db = pg.db;
  const { buildApp } = await import("../src/server");
  app = buildApp({
    verifyProof: mockVerifyProof,
    createSelfRequest: (a) => selfRequestImpl(a),
    getSelfRequest: (a) => selfStatusImpl(a),
    logger: false,
  });
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

beforeEach(async () => {
  if (pg) await truncateAll(db);
});

async function insertQuestion(opts: {
  text?: string;
  options?: string[];
  scope?: string;
  country?: string | null;
  continent?: string | null;
  closesInMinutes?: number;
  status?: string;
} = {}): Promise<{ id: string; nonce: string }> {
  const rows = (await db.execute(sql`
    INSERT INTO questions (text, options, scope, country, continent, closes_at, status)
    VALUES (
      ${opts.text ?? "Do you?"},
      ${JSON.stringify(opts.options ?? ["yes", "no"])}::jsonb,
      ${opts.scope ?? "worldwide"},
      ${opts.country ?? null},
      ${opts.continent ?? null},
      now() + make_interval(mins => ${opts.closesInMinutes ?? 60}),
      ${opts.status ?? "open"}
    )
    RETURNING id, nonce
  `)) as unknown as Array<{ id: string; nonce: string }>;
  return rows[0];
}

async function devToken(opts: {
  uid?: string;
  nationality?: string;
  thresholds?: number[];
} = {}): Promise<DelegationToken> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/dev/register",
    payload: {
      agent_key: agentKeyB64,
      unique_identifier: opts.uid ?? null,
      nationality: opts.nationality ?? "US",
      satisfied_thresholds: opts.thresholds ?? [18],
    },
  });
  if (res.statusCode !== 200 || !res.json().delegation_token) {
    throw new Error(`dev register failed: ${res.statusCode} ${res.body}`);
  }
  return res.json().delegation_token as DelegationToken;
}

async function totalAnswers(questionId: string): Promise<number | null> {
  const rows = (await db.execute(
    sql`SELECT total_answers FROM aggregates WHERE question_id = ${questionId}`,
  )) as unknown as Array<{ total_answers: number }>;
  return rows[0] ? Number(rows[0].total_answers) : null;
}

describe("POST /v1/register (verify-once)", () => {
  it("registers a verified enrollment and binds the nullifier", async (ctx) => {
    if (!pg) return ctx.skip();
    const res = await app.inject({
      method: "POST",
      url: "/v1/register",
      payload: makeEnrollment({ uniqueIdentifier: "self:reg-1" }),
    });
    const body = res.json();
    expect(body.accepted).toBe(true);
    expect(body.delegation_token.unique_identifier).toBe("self:reg-1");
    expect(body.delegation_token.disclosed_predicates).toMatchObject({
      region: "EU",
      country: "DE",
      age_band: "35-49",
    });
  });

  it("rejects a different agent_key for an already-bound nullifier", async (ctx) => {
    if (!pg) return ctx.skip();
    await app.inject({ method: "POST", url: "/v1/register", payload: makeEnrollment({ uniqueIdentifier: "self:reg-2" }) });
    const otherKey = Buffer.alloc(32, 7).toString("base64");
    const res = await app.inject({
      method: "POST",
      url: "/v1/register",
      payload: makeEnrollment({ uniqueIdentifier: "self:reg-2", agentKey: otherKey }),
    });
    expect(res.json()).toMatchObject({ accepted: false, reason: "identity_already_bound" });
  });

  it("rejects proofs that disagree on the nullifier", async (ctx) => {
    if (!pg) return ctx.skip();
    const res = await app.inject({
      method: "POST",
      url: "/v1/register",
      payload: makeEnrollment({ perProofNullifier: ["self:a", "self:b", "self:c"] }),
    });
    expect(res.json()).toMatchObject({ accepted: false, reason: "self_nullifier_mismatch" });
  });

  it("rejects an unconfirmed on-chain registry when required", async (ctx) => {
    if (!pg) return ctx.skip();
    process.env.HEARME_BROKER_REQUIRE_REGISTRY_CONFIRMATION = "1";
    const res = await app.inject({
      method: "POST",
      url: "/v1/register",
      payload: makeEnrollment({ uniqueIdentifier: "self:reg-3", registryConfirmed: false }),
    });
    expect(res.json()).toMatchObject({ accepted: false, reason: "self_registry_unconfirmed" });
    delete process.env.HEARME_BROKER_REQUIRE_REGISTRY_CONFIRMATION;
  });
});

describe("POST /v1/dev/register", () => {
  it("mints a synthetic token", async (ctx) => {
    if (!pg) return ctx.skip();
    const tok = await devToken({ uid: "self:dev-1", nationality: "DE", thresholds: [18, 25, 35] });
    expect(tok.unique_identifier).toBe("self:dev-1");
    expect(tok.disclosed_predicates).toMatchObject({ region: "EU", country: "DE", age_band: "35-49" });
  });

  it("rejects a malformed agent_key", async (ctx) => {
    if (!pg) return ctx.skip();
    const res = await app.inject({
      method: "POST",
      url: "/v1/dev/register",
      payload: { agent_key: "not-base64!!", nationality: "US", satisfied_thresholds: [18] },
    });
    expect(res.json()).toMatchObject({ accepted: false, reason: "enrollment_malformed" });
  });
});

describe("POST /v1/envelopes (uniqueness + aggregate)", () => {
  it("accepts one answer, increments the aggregate, then rejects a duplicate", async (ctx) => {
    if (!pg) return ctx.skip();
    const tok = await devToken({ uid: "self:e-1" });
    const question = await insertQuestion({});
    const env = makeEnvelope(tok, { questionId: question.id, answer: "yes", nonce: question.nonce });

    const first = await app.inject({ method: "POST", url: "/v1/envelopes", payload: env });
    expect(first.json()).toEqual({ accepted: true, reason: null });
    expect(await totalAnswers(question.id)).toBe(1);

    const dup = await app.inject({ method: "POST", url: "/v1/envelopes", payload: env });
    expect(dup.json()).toMatchObject({ accepted: false, reason: "duplicate" });
    expect(await totalAnswers(question.id)).toBe(1);
  });

  it("stores no_signal and it does not count as signal (§1.14 / §15.4)", async (ctx) => {
    if (!pg) return ctx.skip();
    const tok = await devToken({ uid: "self:e-ns", nationality: "DE", thresholds: [18, 25, 35] });
    const question = await insertQuestion({});
    // no_signal is unsigned metadata; the agent_signature is unchanged, so we
    // just set the flag on an otherwise-valid envelope (empty answer per §1.14).
    const env = { ...makeEnvelope(tok, { questionId: question.id, answer: "", nonce: question.nonce }), no_signal: true };
    expect((await app.inject({ method: "POST", url: "/v1/envelopes", payload: env })).json()).toEqual({
      accepted: true,
      reason: null,
    });
    const rows = (await db.execute(
      sql`SELECT no_signal FROM envelopes WHERE unique_identifier = 'self:e-ns'`,
    )) as unknown as Array<{ no_signal: boolean }>;
    expect(rows[0].no_signal).toBe(true);
    // And it counts toward total but not signal in the asker gate.
    const elig = (await app.inject({
      method: "POST",
      url: "/v1/askers/eligibility",
      payload: { delegation_token: tok },
    })).json();
    expect(elig).toMatchObject({ total_answers: 1, signal_answers: 0 });

    // First-class aggregation (§1.14): counted in total + the dedicated
    // no_signal fields, but NOT in the per-option by_predicate tallies.
    const agg = (await db.execute(sql`
      SELECT total_answers, by_predicate, no_signal_total, no_signal_by_predicate
      FROM aggregates WHERE question_id = ${question.id}
    `)) as unknown as Array<{
      total_answers: number;
      by_predicate: Record<string, unknown>;
      no_signal_total: number;
      no_signal_by_predicate: Record<string, number>;
    }>;
    expect(Number(agg[0].total_answers)).toBe(1);
    expect(Number(agg[0].no_signal_total)).toBe(1);
    // dev-register (DE) discloses region:EU + country:DE → each gets a no_signal
    // count of 1, and the option tallies stay empty.
    expect(agg[0].no_signal_by_predicate).toMatchObject({ "region:EU": 1, "country:DE": 1 });
    expect(agg[0].by_predicate).toEqual({});
  });

  it("a signal answer leaves no_signal aggregates empty", async (ctx) => {
    if (!pg) return ctx.skip();
    const tok = await devToken({ uid: "self:e-sig" });
    const question = await insertQuestion({});
    await app.inject({
      method: "POST",
      url: "/v1/envelopes",
      payload: makeEnvelope(tok, { questionId: question.id, answer: "yes", nonce: question.nonce }),
    });
    const agg = (await db.execute(sql`
      SELECT no_signal_total, no_signal_by_predicate FROM aggregates WHERE question_id = ${question.id}
    `)) as unknown as Array<{ no_signal_total: number; no_signal_by_predicate: Record<string, number> }>;
    expect(Number(agg[0].no_signal_total)).toBe(0);
    expect(agg[0].no_signal_by_predicate).toEqual({});
  });

  it("rejects a nonce mismatch and a bad agent signature", async (ctx) => {
    if (!pg) return ctx.skip();
    const tok = await devToken({ uid: "self:e-2" });
    const question = await insertQuestion({});
    const wrongNonce = makeEnvelope(tok, { questionId: question.id, answer: "yes", nonce: "wrong" });
    expect((await app.inject({ method: "POST", url: "/v1/envelopes", payload: wrongNonce })).json()).toMatchObject({
      accepted: false,
      reason: "nonce_mismatch",
    });

    const tampered = makeEnvelope(tok, { questionId: question.id, answer: "yes", nonce: question.nonce });
    tampered.answer = "no"; // signature no longer matches
    expect((await app.inject({ method: "POST", url: "/v1/envelopes", payload: tampered })).json()).toMatchObject({
      accepted: false,
      reason: "agent_signature_invalid",
    });
  });

  it("enforces country scope eligibility", async (ctx) => {
    if (!pg) return ctx.skip();
    const tok = await devToken({ uid: "self:e-3", nationality: "DE" }); // region EU, country DE
    const wrong = await insertQuestion({ scope: "country", country: "FR", continent: "EU" });
    expect(
      (await app.inject({
        method: "POST",
        url: "/v1/envelopes",
        payload: makeEnvelope(tok, { questionId: wrong.id, answer: "yes", nonce: wrong.nonce }),
      })).json(),
    ).toMatchObject({ accepted: false, reason: "scope_ineligible" });

    const right = await insertQuestion({ scope: "country", country: "DE", continent: "EU" });
    expect(
      (await app.inject({
        method: "POST",
        url: "/v1/envelopes",
        payload: makeEnvelope(tok, { questionId: right.id, answer: "yes", nonce: right.nonce }),
      })).json(),
    ).toEqual({ accepted: true, reason: null });
  });

  it("rejects a closed question", async (ctx) => {
    if (!pg) return ctx.skip();
    const tok = await devToken({ uid: "self:e-4" });
    const closed = await insertQuestion({ closesInMinutes: -10 });
    expect(
      (await app.inject({
        method: "POST",
        url: "/v1/envelopes",
        payload: makeEnvelope(tok, { questionId: closed.id, answer: "yes", nonce: closed.nonce }),
      })).json(),
    ).toMatchObject({ accepted: false, reason: "question_closed" });
  });
});

describe("POST /v1/envelopes/revoke (override is sacred)", () => {
  it("deletes the answer, recomputes the aggregate, and is idempotent", async (ctx) => {
    if (!pg) return ctx.skip();
    const tok = await devToken({ uid: "self:r-1" });
    const question = await insertQuestion({});
    await app.inject({
      method: "POST",
      url: "/v1/envelopes",
      payload: makeEnvelope(tok, { questionId: question.id, answer: "yes", nonce: question.nonce }),
    });
    expect(await totalAnswers(question.id)).toBe(1);

    const rev = makeRevocation(tok, { questionId: question.id });
    const first = await app.inject({ method: "POST", url: "/v1/envelopes/revoke", payload: rev });
    expect(first.json()).toMatchObject({ accepted: true, found: true });
    expect(await totalAnswers(question.id)).toBe(null); // aggregate row removed

    const second = await app.inject({ method: "POST", url: "/v1/envelopes/revoke", payload: rev });
    expect(second.json()).toMatchObject({ accepted: true, found: false });
  });
});

describe("GET /v1/stats", () => {
  it("counts registrations, answers, and respondents", async (ctx) => {
    if (!pg) return ctx.skip();
    const question = await insertQuestion({});
    for (const uid of ["self:s-1", "self:s-2"]) {
      const tok = await devToken({ uid });
      await app.inject({
        method: "POST",
        url: "/v1/envelopes",
        payload: makeEnvelope(tok, { questionId: question.id, answer: "yes", nonce: question.nonce }),
      });
    }
    const stats = (await app.inject({ method: "GET", url: "/v1/stats" })).json();
    expect(stats).toMatchObject({
      registered_agents: 2,
      total_answers: 2,
      respondents: 2,
      answered_questions: 1,
    });
    expect(stats.questions).toBeGreaterThanOrEqual(1);
  });
});

describe("POST /v1/askers/eligibility (asker auth + unlock threshold, §15.3)", () => {
  // Seed one envelope (one answer) for `uid` against a fresh question. An empty
  // answer marks a no-signal envelope (no_signal=true, §1.14); a non-empty
  // answer is signal-bearing (no_signal=false).
  async function seedAnswer(uid: string, answer: string): Promise<void> {
    const q = await insertQuestion({});
    const noSignal = answer.trim() === "";
    await db.execute(sql`
      INSERT INTO envelopes (
        question_id, unique_identifier, answer, no_signal,
        disclosed_predicates, agent_signature, delegation_hash
      ) VALUES (
        ${q.id}, ${uid}, ${answer}, ${noSignal},
        '{}'::jsonb, 'sig', 'hash'
      )
    `);
  }

  // Authenticate as `uid` by minting a real broker-signed token (dev register)
  // and posting it — the same credential an onboarded asker would present.
  async function eligibilityFor(uid: string) {
    const token = await devToken({ uid });
    return (
      await app.inject({
        method: "POST",
        url: "/v1/askers/eligibility",
        payload: { delegation_token: token },
      })
    ).json();
  }

  it("rejects a token with no backing registration (auth fails)", async (ctx) => {
    if (!pg) return ctx.skip();
    // A validly broker-signed token whose nullifier was never registered.
    const token = makeToken({ uniqueIdentifier: "self:never-registered" });
    const res = await app.inject({
      method: "POST",
      url: "/v1/askers/eligibility",
      payload: { delegation_token: token },
    });
    expect(res.json()).toMatchObject({
      authorized: false,
      auth_reason: "registration_not_found",
      unique_identifier: null,
      can_ask: false,
    });
  });

  it("rejects a token not signed by this broker", async (ctx) => {
    if (!pg) return ctx.skip();
    // A validly shaped token whose broker_signature has been tampered.
    const token = { ...makeToken({ uniqueIdentifier: "self:x" }), broker_signature: "AAAA" };
    expect((await app.inject({
      method: "POST",
      url: "/v1/askers/eligibility",
      payload: { delegation_token: token },
    })).json()).toMatchObject({ authorized: false, auth_reason: "broker_signature_invalid" });
  });

  it("authenticates a registered identity with zero answers — cannot ask yet", async (ctx) => {
    if (!pg) return ctx.skip();
    expect(await eligibilityFor("self:fresh")).toMatchObject({
      authorized: true,
      unique_identifier: "self:fresh",
      can_ask: false,
      total_answers: 0,
      signal_answers: 0,
      required_total: 50,
      required_signal: 10,
      remaining_total: 50,
      remaining_signal: 10,
      reason: "not_enough_answers",
    });
  });

  it("counts total vs signal and unlocks at the threshold", async (ctx) => {
    if (!pg) return ctx.skip();
    const uid = "self:asker-ok";
    // 50 answers, exactly 10 of them signal-bearing — the §15.3 boundary.
    for (let i = 0; i < 10; i++) await seedAnswer(uid, "yes");
    for (let i = 0; i < 40; i++) await seedAnswer(uid, ""); // no_signal proxy
    expect(await eligibilityFor(uid)).toMatchObject({
      authorized: true,
      can_ask: true,
      total_answers: 50,
      signal_answers: 10,
      remaining_total: 0,
      remaining_signal: 0,
      reason: null,
    });
  });

  it("enough total but too little signal is blocked (anti-farming, §15.4)", async (ctx) => {
    if (!pg) return ctx.skip();
    const uid = "self:asker-farm";
    for (let i = 0; i < 3; i++) await seedAnswer(uid, "yes");
    for (let i = 0; i < 55; i++) await seedAnswer(uid, "");
    expect(await eligibilityFor(uid)).toMatchObject({
      authorized: true,
      can_ask: false,
      total_answers: 58,
      signal_answers: 3,
      remaining_total: 0,
      remaining_signal: 7,
      reason: "not_enough_signal",
    });
  });

  it("counts are scoped to the authenticated identity (no cross-talk)", async (ctx) => {
    if (!pg) return ctx.skip();
    await seedAnswer("self:a", "yes");
    await seedAnswer("self:b", "yes");
    expect((await eligibilityFor("self:a")).total_answers).toBe(1);
  });

  it("a DB-listed admin bypasses the threshold with zero answers (§15.3)", async (ctx) => {
    if (!pg) return ctx.skip();
    const uid = "self:db-admin";
    await db.execute(sql`
      INSERT INTO asker_admins (unique_identifier, label) VALUES (${uid}, 'seed')
    `);
    expect(await eligibilityFor(uid)).toMatchObject({
      authorized: true,
      unique_identifier: uid,
      can_ask: true,
      is_admin: true,
      total_answers: 0,
      signal_answers: 0,
      remaining_total: 0,
      remaining_signal: 0,
      reason: null,
    });
  });

  it("grant/revoke round-trips and flips ask-rights live (§15.3)", async (ctx) => {
    if (!pg) return ctx.skip();
    const uid = "self:toggle-admin";
    // Not an admin and no answers ⇒ blocked.
    expect(await eligibilityFor(uid)).toMatchObject({ can_ask: false, is_admin: false });
    await q.grantAskerAdmin(db, { uniqueIdentifier: uid, label: "Alice" });
    expect(await eligibilityFor(uid)).toMatchObject({ can_ask: true, is_admin: true });
    expect(await q.isAskerAdmin(db, uid)).toBe(true);
    // Revoke drops the row and the bypass.
    expect(await q.revokeAskerAdmin(db, uid)).toBe(true);
    expect(await q.revokeAskerAdmin(db, uid)).toBe(false); // already gone
    expect(await eligibilityFor(uid)).toMatchObject({ can_ask: false, is_admin: false });
  });
});

describe("asker Sign in with Self (login + session, §15.3)", () => {
  // Seed one (signal-bearing) answer for `uid` against a fresh question.
  async function seedAnswer(uid: string, answer: string): Promise<void> {
    const q = await insertQuestion({});
    const noSignal = answer.trim() === "";
    await db.execute(sql`
      INSERT INTO envelopes (
        question_id, unique_identifier, answer, no_signal,
        disclosed_predicates, agent_signature, delegation_hash
      ) VALUES (
        ${q.id}, ${uid}, ${answer}, ${noSignal},
        '{}'::jsonb, 'sig', 'hash'
      )
    `);
  }

  it("login/start returns the bridge's requestId + qr urls", async (ctx) => {
    if (!pg) return ctx.skip();
    selfRequestImpl = async ({ agentKey, profile }) => {
      // Asker login uses a throwaway agent key and the minimal profile.
      expect(typeof agentKey).toBe("string");
      expect(profile).toBe("minimal");
      return { requestId: "req-1", urls: ["https://self.app/x"] };
    };
    const res = await app.inject({ method: "POST", url: "/v1/askers/login/start", payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ request_id: "req-1", qr_urls: ["https://self.app/x"] });
  });

  it("login/start surfaces a bridge outage as 502", async (ctx) => {
    if (!pg) return ctx.skip();
    const { BridgeError } = await import("../src/verify/bridgeClient");
    selfRequestImpl = async () => {
      throw new BridgeError("bridge down");
    };
    const res = await app.inject({ method: "POST", url: "/v1/askers/login/start", payload: {} });
    expect(res.statusCode).toBe(502);
  });

  it("login/status is pending until a proof lands", async (ctx) => {
    if (!pg) return ctx.skip();
    selfStatusImpl = async () => ({
      found: true,
      status: "pending",
      verified: false,
      uniqueIdentifier: null,
      registryConfirmed: false,
    });
    const res = await app.inject({ method: "GET", url: "/v1/askers/login/req-1/status" });
    expect(res.json()).toMatchObject({ status: "pending", asker_session: null });
  });

  it("login/status 404s an unknown requestId", async (ctx) => {
    if (!pg) return ctx.skip();
    selfStatusImpl = async () => ({
      found: false,
      status: "pending",
      verified: false,
      uniqueIdentifier: null,
      registryConfirmed: false,
    });
    const res = await app.inject({ method: "GET", url: "/v1/askers/login/nope/status" });
    expect(res.statusCode).toBe(404);
  });

  it("login/status fails a proof that did not verify", async (ctx) => {
    if (!pg) return ctx.skip();
    selfStatusImpl = async () => ({
      found: true,
      status: "complete",
      verified: false,
      uniqueIdentifier: null,
      registryConfirmed: false,
    });
    const res = await app.inject({ method: "GET", url: "/v1/askers/login/req-1/status" });
    expect(res.json()).toMatchObject({ status: "failed", asker_session: null });
  });

  it("login/status on a verified scan returns the gate + a session", async (ctx) => {
    if (!pg) return ctx.skip();
    const uid = "self:login-ok";
    // 50 answers, 10 signal-bearing — clears the unlock threshold.
    for (let i = 0; i < 10; i++) await seedAnswer(uid, "yes");
    for (let i = 0; i < 40; i++) await seedAnswer(uid, "");
    selfStatusImpl = async () => ({
      found: true,
      status: "complete",
      verified: true,
      uniqueIdentifier: uid,
      registryConfirmed: true,
    });
    const body = (await app.inject({ method: "GET", url: "/v1/askers/login/req-1/status" })).json();
    expect(body).toMatchObject({
      status: "complete",
      eligibility: { authorized: true, unique_identifier: uid, can_ask: true, total_answers: 50 },
    });
    expect(body.asker_session).toMatchObject({ kind: "asker_session", unique_identifier: uid });

    // The session re-verifies and reports the same gate at submit time.
    const verify = await app.inject({
      method: "POST",
      url: "/v1/askers/session/verify",
      payload: { asker_session: body.asker_session },
    });
    expect(verify.json()).toMatchObject({ authorized: true, can_ask: true, unique_identifier: uid });
  });

  it("login/status rejects a verified scan whose root is unconfirmed", async (ctx) => {
    if (!pg) return ctx.skip();
    selfStatusImpl = async () => ({
      found: true,
      status: "complete",
      verified: true,
      uniqueIdentifier: "self:unconfirmed",
      registryConfirmed: false, // requireRegistryConfirmation defaults true
    });
    const res = await app.inject({ method: "GET", url: "/v1/askers/login/req-1/status" });
    expect(res.json()).toMatchObject({ status: "failed" });
  });

  it("session/verify gates an identity below threshold (can_ask false)", async (ctx) => {
    if (!pg) return ctx.skip();
    const uid = "self:login-fresh";
    const session = issueAskerSession({
      unique_identifier: uid,
      issued_at: new Date(),
      expires_at: new Date(Date.now() + ASKER_SESSION_TTL_MS),
    });
    expect(
      (await app.inject({
        method: "POST",
        url: "/v1/askers/session/verify",
        payload: { asker_session: session },
      })).json(),
    ).toMatchObject({ authorized: true, can_ask: false, total_answers: 0, reason: "not_enough_answers" });
  });

  it("session/verify rejects an expired session", async (ctx) => {
    if (!pg) return ctx.skip();
    const session = issueAskerSession({
      unique_identifier: "self:whoever",
      issued_at: new Date(Date.now() - 2 * ASKER_SESSION_TTL_MS),
      expires_at: new Date(Date.now() - ASKER_SESSION_TTL_MS),
    });
    expect(
      (await app.inject({
        method: "POST",
        url: "/v1/askers/session/verify",
        payload: { asker_session: session },
      })).json(),
    ).toMatchObject({ authorized: false, auth_reason: "token_expired", unique_identifier: null });
  });

  it("session/verify rejects a forged/tampered session", async (ctx) => {
    if (!pg) return ctx.skip();
    const session = issueAskerSession({
      unique_identifier: "self:real",
      issued_at: new Date(),
      expires_at: new Date(Date.now() + ASKER_SESSION_TTL_MS),
    });
    expect(
      (await app.inject({
        method: "POST",
        url: "/v1/askers/session/verify",
        payload: { asker_session: { ...session, unique_identifier: "self:evil" } },
      })).json(),
    ).toMatchObject({ authorized: false, auth_reason: "broker_signature_invalid" });
  });
});

describe("GET /healthz", () => {
  it("returns ok", async (ctx) => {
    if (!pg) return ctx.skip();
    expect((await app.inject({ method: "GET", url: "/healthz" })).json()).toEqual({ status: "ok" });
  });
});
