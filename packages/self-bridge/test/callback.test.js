// Coverage for /callback — the SelfApp endpoint where the Self app POSTs a
// proof and the bridge verifies + routes it back to its originating request.
// This is the security-critical heart of enrollment, so the dispatch and
// verify-result handling are exercised here.
//
// The real verify() runs a SNARK check through @selfxyz/core against the Celo
// RPC, which can't run in CI. We inject a deterministic SDK-shaped stand-in via
// __setVerifyImpl, so these tests cover everything the handler does AROUND the
// proof check: malformed-body rejection, routing by userIdentifier, storing the
// bundle, the isValid:false / unroutable / thrown paths, and the
// verifyOne extraction (nullifier, disclosed map, bound agent key).
//
// Unlike smoke.test.js this imports server.js, so it needs the dependencies
// installed (`npm install`) — express + the @selfxyz SDK load at import time.

import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import { app, __setVerifyImpl, __seedPending, __resetState } from "../src/server.js";

let server;
let base;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      const { port } = server.address();
      base = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(() => {
  server?.close();
});

beforeEach(() => {
  __resetState();
});

function post(path, body) {
  return fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// A complete, well-formed callback body. The four fields are opaque to the
// bridge (handed straight to verify()), so any non-empty values pass the
// malformed gate.
const GOOD_BODY = {
  attestationId: 1,
  proof: { a: "0x1" },
  publicSignals: ["0x2", "0x3"],
  userContextData: "0xdeadbeef",
};

// The agent key a default sdkResult() binds to, in the same base64 form the
// bridge stores in `entry.agentKey` (decodeBoundAgentKey round-trips the proof's
// userDefinedData back to this). Seed pending requests with this so the
// mandatory agent-key bind in /callback passes on the happy path.
const SEED_AGENT_KEY = Buffer.from("ab".repeat(32), "hex").toString("base64");

// Build an SDK-shaped verify() result. `userId` controls routing; the bound
// agent key round-trips through decodeBoundAgentKey (hex-of-ascii-"0x"+hexkey).
function sdkResult({ isValid = true, userId = "0x01", agentKeyHex = "ab".repeat(32) }) {
  const ascii = "0x" + agentKeyHex; // what the skill put in userDefinedData
  const userDefinedData = Buffer.from(ascii, "utf8").toString("hex");
  return {
    isValidDetails: { isValid },
    userData: { userIdentifier: userId, userDefinedData },
    discloseOutput: { nullifier: "nullifier-xyz", nationality: "DE", olderThan: "35" },
  };
}

test("rejects a malformed body with 400 and does not call verify", async () => {
  let called = false;
  __setVerifyImpl(async () => {
    called = true;
    return sdkResult({});
  });

  for (const missing of ["attestationId", "proof", "publicSignals", "userContextData"]) {
    const body = { ...GOOD_BODY };
    delete body[missing];
    const res = await post("/callback", body);
    assert.equal(res.status, 400, `missing ${missing} should 400`);
    const json = await res.json();
    assert.deepEqual(json, { status: "error", reason: "malformed" });
  }
  assert.equal(called, false, "verify() must not run on a malformed body");
});

test("a verified proof is routed to its request and stored", async () => {
  const userId = "0x2a"; // 42 — exercises BigInt normalization vs the seed below
  __seedPending({ requestId: "req-1", thresholds: [35], userId, threshold: 35, agentKey: SEED_AGENT_KEY });
  __setVerifyImpl(async () => sdkResult({ isValid: true, userId }));

  const res = await post("/callback", GOOD_BODY);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "success", result: true });

  // The request is now complete: one expected threshold, one stored proof.
  const poll = await fetch(base + "/requests/req-1");
  assert.equal(poll.status, 200);
  const got = await poll.json();
  assert.equal(got.status, "complete");
  assert.equal(got.verified, true);
  assert.equal(got.registryConfirmed, true);
  assert.equal(got.uniqueIdentifier, "nullifier-xyz");
  assert.equal(got.bundles.length, 1);
  assert.deepEqual(got.bundles[0], GOOD_BODY);
  // verifyOne -> mapDisclosed: nationality + older_than (as int).
  assert.deepEqual(got.disclosed, [{ nationality: "DE", older_than: 35 }]);
  // decodeBoundAgentKey turned the hex-of-ascii key back into base64.
  const expectedKey = Buffer.from("ab".repeat(32), "hex").toString("base64");
  assert.equal(got.boundAgentKey, expectedKey);
});

test("userId routing tolerates 0x-prefix / zero-padding differences", async () => {
  // Seed under a padded hex; the proof echoes the same number unpadded, no 0x.
  __seedPending({ requestId: "req-pad", thresholds: [18], userId: "0x0000002a", threshold: 18, agentKey: SEED_AGENT_KEY });
  __setVerifyImpl(async () => sdkResult({ isValid: true, userId: "2a" }));

  const res = await post("/callback", GOOD_BODY);
  assert.deepEqual(await res.json(), { status: "success", result: true });

  const got = await (await fetch(base + "/requests/req-pad")).json();
  assert.equal(got.status, "complete");
  assert.equal(got.bundles.length, 1);
});

test("an isValid:false proof acks result:false and is not counted as verified", async () => {
  const userId = "0x07";
  __seedPending({ requestId: "req-bad", thresholds: [18], userId, threshold: 18, agentKey: SEED_AGENT_KEY });
  __setVerifyImpl(async () => sdkResult({ isValid: false, userId }));

  const res = await post("/callback", GOOD_BODY);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "success", result: false });

  // The (failed) proof still lands in the request, so it completes — but
  // `verified` reflects that the proof did not pass.
  const got = await (await fetch(base + "/requests/req-bad")).json();
  assert.equal(got.status, "complete");
  assert.equal(got.verified, false);
  assert.equal(got.registryConfirmed, false);
});

test("an unroutable userIdentifier is discarded, not stored anywhere", async () => {
  __seedPending({ requestId: "req-x", thresholds: [18], userId: "0x01", threshold: 18, agentKey: SEED_AGENT_KEY });
  // Proof verifies, but echoes a userId nothing was minted for.
  __setVerifyImpl(async () => sdkResult({ isValid: true, userId: "0xdead" }));

  const res = await post("/callback", GOOD_BODY);
  assert.equal(res.status, 200);
  // Still a successful verify ack...
  assert.deepEqual(await res.json(), { status: "success", result: true });
  // ...but the seeded request never advanced (no proof stored), so it is still
  // pending, not complete.
  const got = await (await fetch(base + "/requests/req-x")).json();
  assert.equal(got.status, "pending");
});

test("a proof whose bound agent key mismatches the request is discarded", async () => {
  const userId = "0x33";
  // Request was created for SEED_AGENT_KEY, but the proof binds a different key.
  __seedPending({ requestId: "req-bind", thresholds: [18], userId, threshold: 18, agentKey: SEED_AGENT_KEY });
  __setVerifyImpl(async () =>
    sdkResult({ isValid: true, userId, agentKeyHex: "cd".repeat(32) }),
  );

  const res = await post("/callback", GOOD_BODY);
  assert.equal(res.status, 200);
  // Same ack shape as the routed path, but the proof was NOT stored.
  assert.deepEqual(await res.json(), { status: "success", result: true });

  // The seeded request never advanced — the mismatched proof was discarded.
  const got = await (await fetch(base + "/requests/req-bind")).json();
  assert.equal(got.status, "pending");
});

test("a proof with no decodable bound agent key is discarded", async () => {
  const userId = "0x44";
  __seedPending({ requestId: "req-nobind", thresholds: [18], userId, threshold: 18, agentKey: SEED_AGENT_KEY });
  // userDefinedData that decodes to null (odd-length inner hex after "0x").
  __setVerifyImpl(async () => {
    const userDefinedData = Buffer.from("0xabc", "utf8").toString("hex");
    return {
      isValidDetails: { isValid: true },
      userData: { userIdentifier: userId, userDefinedData },
      discloseOutput: { nullifier: "nullifier-xyz", nationality: "DE", olderThan: "18" },
    };
  });

  const res = await post("/callback", GOOD_BODY);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "success", result: true });

  const got = await (await fetch(base + "/requests/req-nobind")).json();
  assert.equal(got.status, "pending");
});

test("a verify() that throws surfaces as a 500 error ack", async () => {
  __setVerifyImpl(async () => {
    throw new Error("celo rpc unreachable");
  });

  const res = await post("/callback", GOOD_BODY);
  assert.equal(res.status, 500);
  const json = await res.json();
  assert.equal(json.status, "error");
  assert.match(json.reason, /celo rpc unreachable/);
});

test("a web request stores a verified proof without an agent-key bind", async () => {
  const userId = "0x55";
  // web:true entry has no agentKey to bind against.
  __seedPending({ requestId: "req-web", thresholds: [18], userId, threshold: 18, web: true });
  // A proof whose bound key would NOT match any agent key — irrelevant for web.
  __setVerifyImpl(async () =>
    sdkResult({ isValid: true, userId, agentKeyHex: "cd".repeat(32) }),
  );

  const res = await post("/callback", GOOD_BODY);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "success", result: true });

  // Stored despite the (ignored) bind — the web flow only needs the nullifier.
  const got = await (await fetch(base + "/requests/req-web")).json();
  assert.equal(got.status, "complete");
  assert.equal(got.verified, true);
  assert.equal(got.uniqueIdentifier, "nullifier-xyz");
});

test("a multi-threshold request stays pending until every proof arrives", async () => {
  __seedPending({ requestId: "req-multi", thresholds: [18, 25], userId: "0x11", threshold: 18, agentKey: SEED_AGENT_KEY });
  // Register the second expected proof under the same request.
  __seedPending({ requestId: "req-multi", thresholds: [18, 25], userId: "0x12", threshold: 25, agentKey: SEED_AGENT_KEY });

  __setVerifyImpl(async () => sdkResult({ isValid: true, userId: "0x11" }));
  await post("/callback", GOOD_BODY);
  let got = await (await fetch(base + "/requests/req-multi")).json();
  assert.equal(got.status, "pending", "one of two proofs in -> still pending");

  __setVerifyImpl(async () => sdkResult({ isValid: true, userId: "0x12" }));
  await post("/callback", GOOD_BODY);
  got = await (await fetch(base + "/requests/req-multi")).json();
  assert.equal(got.status, "complete", "both proofs in -> complete");
  assert.equal(got.bundles.length, 2);
  assert.equal(got.verified, true);
});
