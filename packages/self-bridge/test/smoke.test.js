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
