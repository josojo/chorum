import { test } from "node:test";
import assert from "node:assert/strict";

import { mapDisclosedPredicates } from "../src/disclosure.js";
import { app } from "../src/server.js";

test("mapDisclosedPredicates collapses a QueryResult to hearme predicate keys", () => {
  const qr = {
    age: { gte: { result: true } },
    nationality: { in: { result: true } },
  };
  assert.deepEqual(mapDisclosedPredicates(qr), { age_band: "18+", region: "EU" });
  assert.deepEqual(mapDisclosedPredicates({}), {});
  assert.deepEqual(mapDisclosedPredicates({ age: { gte: { result: false } } }), {});
});

test("POST /verify with no proofs returns verified:false (no network, no bb.js)", async () => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        proofs: [],
        query: { bind: { custom_data: "AGENT_KEY_B64" } },
        queryResult: {},
      }),
    });
    const body = await resp.json();
    assert.equal(body.verified, false);
    assert.equal(body.boundAgentKey, "AGENT_KEY_B64");
  } finally {
    server.close();
  }
});

test("POST /verify rejects malformed input with 400", async () => {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proofs: "nope" }),
    });
    assert.equal(resp.status, 400);
  } finally {
    server.close();
  }
});
