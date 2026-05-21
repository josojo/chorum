// Network-free, SDK-free smoke tests for the pure helpers. The server (which
// imports @selfxyz/*) is exercised in integration, not here, so `npm test`
// runs without the SDK installed or a real passport.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  disclosuresForThreshold,
  mapDisclosed,
  profileThresholds,
} from "../src/disclosure.js";
import { confirmRegistry, decodeBool, encodeRootIsKnown } from "../src/registry.js";

test("profileThresholds: standard ladder + minimal gate", () => {
  assert.deepEqual(profileThresholds("minimal"), [18]);
  assert.deepEqual(profileThresholds("standard"), [18, 25, 35, 50, 65]);
  assert.deepEqual(profileThresholds(), [18, 25, 35, 50, 65]);
});

test("disclosuresForThreshold: nationality + the one minimumAge", () => {
  assert.deepEqual(disclosuresForThreshold(35), {
    nationality: true,
    minimumAge: 35,
  });
});

test("mapDisclosed: nationality + older_than (as int)", () => {
  assert.deepEqual(mapDisclosed({ nationality: "DE", olderThan: "35" }), {
    nationality: "DE",
    older_than: 35,
  });
  assert.deepEqual(mapDisclosed({ nationality: "US", olderThan: 18 }), {
    nationality: "US",
    older_than: 18,
  });
  assert.deepEqual(mapDisclosed({}), {});
});

test("registry: encode/decode helpers", () => {
  const data = encodeRootIsKnown("0x01");
  assert.equal(data.length, 10 + 64); // 0x + 4-byte selector + 32-byte word
  assert.equal(decodeBool("0x" + "0".repeat(63) + "1"), true);
  assert.equal(decodeBool("0x" + "0".repeat(64)), false);
  assert.equal(decodeBool(undefined), false);
});

test("confirmRegistry: guards when unconfigured", async () => {
  assert.deepEqual(await confirmRegistry({}), { confirmed: false, reason: "no_rpc" });
  assert.deepEqual(
    await confirmRegistry({ rpcUrl: "http://x", registryAddress: "0xabc" }),
    { confirmed: false, reason: "no_root" },
  );
});

test("confirmRegistry: confirmed via injected fetch (known root)", async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({ result: "0x" + "0".repeat(63) + "1" }),
  });
  const out = await confirmRegistry({
    rpcUrl: "http://celo",
    registryAddress: "0xregistry",
    root: "12345",
    fetchImpl: fakeFetch,
  });
  assert.deepEqual(out, { confirmed: true, reason: "ok" });
});

test("confirmRegistry: unknown root -> not confirmed", async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({ result: "0x" + "0".repeat(64) }),
  });
  const out = await confirmRegistry({
    rpcUrl: "http://celo",
    registryAddress: "0xregistry",
    root: "12345",
    fetchImpl: fakeFetch,
  });
  assert.deepEqual(out, { confirmed: false, reason: "root_unknown" });
});
