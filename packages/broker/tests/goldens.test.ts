// Cross-language golden vectors recorded from the Python broker (the
// authoritative implementation the chorum-skill was built against). These pin
// byte-for-byte compatibility of canonical JSON, Ed25519 signing, the envelope
// signing input, and predicate derivation. If any of these break, agents in the
// field stop verifying.

import { describe, it, expect } from "vitest";

import { canonicalJson, delegationHash } from "../src/verify/canonical";
import { issueDelegationToken, verifyBrokerSignature } from "../src/verify/credential";
import {
  envelopeSigningInput,
  revocationSigningInput,
  verifyAgentSignature,
  verifyRevocationSignature,
} from "../src/verify/envelope";
import { derivePredicates } from "../src/verify/predicates";
import { classifyAnswer, computeByPredicate, computeNoSignal } from "../src/aggregates";
import type { DelegationToken } from "../src/models";

// The fixed golden DelegationToken (dev signing key) from the Python broker.
const WIRE: DelegationToken = {
  version: 2,
  scope: "chorum-v1",
  unique_identifier: "self:nullifier-1",
  disclosed_predicates: { region: "EU", country: "DE", age_band: "35-49" },
  agent_key: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
  issued_at: "2026-05-31T12:00:00.123456Z",
  expires_at: "2026-08-29T12:00:00.123456Z",
  broker_signature:
    "ukpv3gWGi0PLAcf8YmiABC0XfW9BGK4hOHwXwOE2Twvax1WSoyAsmywCue0piYiJlJQ9Uk0NTrCp0KPBe+zjBA==",
};
const DHASH = "6433b2ffed393ca1192c61f4603c47dccf772c4e75b8ef90c16a1e5ede2f67b3";
const AGENT_PUB = "CzdPHjqsN4fbFaBvAgcfkgbC2o383njYoniN5c0pBro=";
const QID = "11111111-2222-3333-4444-555555555555";

describe("canonical json", () => {
  it("sorts keys at every level, compact separators", () => {
    expect(canonicalJson({ b: 1, a: 2, c: { y: 1, x: 2 } }).toString()).toBe(
      '{"a":2,"b":1,"c":{"x":2,"y":1}}',
    );
    expect(canonicalJson({ k: "v", n: 1 }).toString()).toBe('{"k":"v","n":1}');
  });

  it("matches the Python canonical bytes for the golden token", () => {
    expect(canonicalJson(WIRE).toString()).toBe(
      '{"agent_key":"AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",' +
        '"broker_signature":"ukpv3gWGi0PLAcf8YmiABC0XfW9BGK4hOHwXwOE2Twvax1WSoyAsmywCue0piYiJlJQ9Uk0NTrCp0KPBe+zjBA==",' +
        '"disclosed_predicates":{"age_band":"35-49","country":"DE","region":"EU"},' +
        '"expires_at":"2026-08-29T12:00:00.123456Z",' +
        '"issued_at":"2026-05-31T12:00:00.123456Z",' +
        '"scope":"chorum-v1","unique_identifier":"self:nullifier-1","version":2}',
    );
  });

  it("reproduces the Python delegation_hash", () => {
    expect(delegationHash(WIRE)).toBe(DHASH);
  });
});

describe("broker credential (Ed25519 via tweetnacl)", () => {
  it("verifies a Python-issued token under the dev key", () => {
    expect(verifyBrokerSignature(WIRE)).toBe(true);
  });

  it("reproduces the Python broker_signature byte-for-byte", () => {
    const tok = issueDelegationToken({
      unique_identifier: WIRE.unique_identifier,
      disclosed_predicates: WIRE.disclosed_predicates,
      agent_key: WIRE.agent_key,
      issued_at: WIRE.issued_at, // string -> used verbatim
      expires_at: WIRE.expires_at,
    });
    expect(tok.broker_signature).toBe(WIRE.broker_signature);
  });

  it("rejects a tampered token", () => {
    expect(
      verifyBrokerSignature({ ...WIRE, unique_identifier: "self:evil" }),
    ).toBe(false);
  });
});

describe("envelope + revocation signing inputs", () => {
  it("matches the Python envelope digest", () => {
    expect(Buffer.from(envelopeSigningInput(QID, "yes", "nonce-abc", DHASH)).toString("hex")).toBe(
      "179110283b83729c602a455e75102e8dd61dbf1450a025a7a7535a67df909493",
    );
  });

  it("matches the Python digest for a unicode answer", () => {
    expect(
      Buffer.from(envelopeSigningInput(QID, "café — yes", "nonce-abc", DHASH)).toString("hex"),
    ).toBe("f635e13040ead060a997d3bf3ff7ff9ae0417077f8c67db712173457a3fe3492");
  });

  it("matches the Python revocation digest", () => {
    expect(Buffer.from(revocationSigningInput(QID, DHASH)).toString("hex")).toBe(
      "f1a862f3647ff92a23ad07624800d5c2f4b24717f0aac7085542878b5ae9b813",
    );
  });

  it("verifies the Python-produced agent + revocation signatures", () => {
    expect(() =>
      verifyAgentSignature({
        agentPubkeyBase64: AGENT_PUB,
        questionId: QID,
        answer: "yes",
        nonce: "nonce-abc",
        delegationHashHex: DHASH,
        agentSignatureBase64:
          "7+i3+8I9gFyGxpTuEzRcMren6mF/yNN1c8VoK6qp2l9cJDOcWhDFlg59F6YrAKZOJLCCjlt5FwJpYEbVXXMDAw==",
      }),
    ).not.toThrow();

    expect(() =>
      verifyRevocationSignature({
        agentPubkeyBase64: AGENT_PUB,
        questionId: QID,
        delegationHashHex: DHASH,
        revocationSignatureBase64:
          "7h5CcExeYwvRUmyRlS2nhGnylk2l9GYs0R6Oci9fp0ky72SIq9H5jBNBzS74uykig6TARRrAFmpED4su3oO9BA==",
      }),
    ).not.toThrow();
  });
});

describe("predicate derivation", () => {
  it("matches Python for alpha-3, MRZ, and full ladder", () => {
    expect(derivePredicates({ nationality: "DEU", satisfiedThresholds: [18, 25, 35] })).toEqual({
      region: "EU",
      country: "DE",
      age_band: "35-49",
    });
    expect(derivePredicates({ nationality: "D<<", satisfiedThresholds: [18] })).toEqual({
      region: "EU",
      country: "DE",
      age_band: "18+",
    });
    expect(
      derivePredicates({ nationality: "USA", satisfiedThresholds: [18, 25, 35, 50, 65] }),
    ).toEqual({ region: "NA", country: "US", age_band: "65+" });
  });
});

describe("answer classification + aggregation", () => {
  it("classifies multilingual yes/no and option labels", () => {
    expect(classifyAnswer("Ja, absolutely", ["yes", "no"])).toBe("yes");
    expect(classifyAnswer("Pizza — crust", ["pizza", "pasta", "sushi"])).toBe("pizza");
  });

  it("classifies multi-word options the agent signed (regression for #110)", () => {
    const options = [
      "personal assistant",
      "business partner",
      "coding assistant",
      "swarm intelligence",
      "other",
    ];
    // Exact multi-word label — previously rejected as ANSWER_UNCLASSIFIED because
    // only the leading word ("personal") was matched against full labels.
    expect(classifyAnswer("personal assistant", options)).toBe("personal assistant");
    // Case-insensitive + trailing LLM elaboration still resolves to the label.
    expect(classifyAnswer("Coding Assistant, mostly for refactors", options)).toBe(
      "coding assistant",
    );
    // A single-word option still works.
    expect(classifyAnswer("other", options)).toBe("other");
  });

  it("requires a word boundary and prefers the longest matching label", () => {
    // No boundary: a leading "otherwise" must not select "other".
    expect(classifyAnswer("otherwise", ["other", "no"])).toBeNull();
    // Longest full-label prefix wins over a shorter shared prefix.
    expect(classifyAnswer("coding assistant", ["coding", "coding assistant"])).toBe(
      "coding assistant",
    );
    // Genuinely unrelated answer stays unclassified.
    expect(classifyAnswer("maybe later", ["personal assistant", "other"])).toBeNull();
  });

  it("matches the Python by_predicate tally", () => {
    expect(
      computeByPredicate(
        [
          { answer: "yes", disclosed_predicates: { region: "EU", age_band: "35-49" } },
          { answer: "no", disclosed_predicates: { region: "EU", age_band: "25-34" } },
        ],
        ["yes", "no"],
      ),
    ).toEqual({
      "region:EU": { yes: 1, no: 1 },
      "age_band:35-49": { yes: 1, no: 0 },
      "age_band:25-34": { yes: 0, no: 1 },
    });
  });

  it("counts no_signal per bucket as a first-class breakdown (§1.14)", () => {
    const envelopes = [
      { answer: "yes", disclosed_predicates: { region: "EU", age_band: "25-34" } },
      { answer: "", no_signal: true, disclosed_predicates: { region: "EU", age_band: "25-34" } },
      { answer: "", no_signal: true, disclosed_predicates: { region: "EU", age_band: "50-64" } },
    ];
    // Signal tallies exclude the no_signal rows entirely.
    expect(computeByPredicate(envelopes.filter((e) => !e.no_signal), ["yes", "no"])).toEqual({
      "region:EU": { yes: 1, no: 0 },
      "age_band:25-34": { yes: 1, no: 0 },
    });
    // no_signal is counted in its own per-bucket map.
    expect(computeNoSignal(envelopes)).toEqual({
      total: 2,
      byPredicate: { "region:EU": 2, "age_band:25-34": 1, "age_band:50-64": 1 },
    });
  });
});
