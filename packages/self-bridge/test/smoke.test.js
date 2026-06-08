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
import { PRODUCTION_SCOPE, resolveScope } from "../src/scope.js";

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

// The scope is FROZEN (GH #97). These guard the one rule that protects the whole
// identity graph: production ignores SELF_SCOPE and pins PRODUCTION_SCOPE.
test("resolveScope: production ignores SELF_SCOPE and pins the frozen value", () => {
  // A stray/typo'd/changed env var must NOT take effect in prod — it is reported
  // back as ignoredEnvScope (so the caller warns) but the scope stays frozen.
  assert.deepEqual(
    resolveScope({ productionMode: true, envScope: "oops-v2" }),
    { scope: PRODUCTION_SCOPE, ignoredEnvScope: "oops-v2" },
  );
  // Env equal to the frozen value (e.g. inherited from base compose): no warning.
  assert.deepEqual(
    resolveScope({ productionMode: true, envScope: PRODUCTION_SCOPE }),
    { scope: PRODUCTION_SCOPE, ignoredEnvScope: null },
  );
  // Unset env in prod: still frozen, no warning.
  assert.deepEqual(
    resolveScope({ productionMode: true, envScope: undefined }),
    { scope: PRODUCTION_SCOPE, ignoredEnvScope: null },
  );
});

test("resolveScope: outside production SELF_SCOPE selects the scope", () => {
  // Staging pins its own distinct frozen scope.
  assert.deepEqual(
    resolveScope({ productionMode: false, envScope: "staging-chorum-v1" }),
    { scope: "staging-chorum-v1", ignoredEnvScope: null },
  );
  // Local dev with no env falls back to the default.
  assert.deepEqual(
    resolveScope({ productionMode: false, envScope: undefined }),
    { scope: PRODUCTION_SCOPE, ignoredEnvScope: null },
  );
});

test("PRODUCTION_SCOPE is the frozen mainnet value", () => {
  assert.equal(PRODUCTION_SCOPE, "chorum-v1");
});
