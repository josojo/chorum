// Cross-language golden vectors recorded from the Python broker (the
// authoritative implementation the hearme-skill was built against). These pin
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
  scope: "hearme-v1",
  unique_identifier: "self:nullifier-1",
  disclosed_predicates: { region: "EU", country: "DE", age_band: "35-49" },
  agent_key: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
  issued_at: "2026-05-31T12:00:00.123456Z",
  expires_at: "2026-08-29T12:00:00.123456Z",
  broker_signature:
    "liH3VGMdnr/MXqqAlxxrIol32jL4Fq43oVeoKpm1Du6mD3JvpjUELKwe/nKeJYrQVflmLp8WOCEnF307TpzaBQ==",
};
const DHASH = "03e9bf5601d898df94914f61003abf783e62b7a0a92c1f2bde32b529a0355717";
const AGENT_PUB = "vG256kFHAI/bBigaiiQjfTdhkr6dz3ul4zMK9ZQPPMk=";
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
        '"broker_signature":"liH3VGMdnr/MXqqAlxxrIol32jL4Fq43oVeoKpm1Du6mD3JvpjUELKwe/nKeJYrQVflmLp8WOCEnF307TpzaBQ==",' +
        '"disclosed_predicates":{"age_band":"35-49","country":"DE","region":"EU"},' +
        '"expires_at":"2026-08-29T12:00:00.123456Z",' +
        '"issued_at":"2026-05-31T12:00:00.123456Z",' +
        '"scope":"hearme-v1","unique_identifier":"self:nullifier-1","version":2}',
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
      "346283939cf650d944d0f2818751d697baee48c813e5329aa7ac5de9599ed7b4",
    );
  });

  it("matches the Python digest for a unicode answer", () => {
    expect(
      Buffer.from(envelopeSigningInput(QID, "café — yes", "nonce-abc", DHASH)).toString("hex"),
    ).toBe("efb2ae673f1ddf1c71b517738959cb840d90f157762cb43321eff12191eb925a");
  });

  it("matches the Python revocation digest", () => {
    expect(Buffer.from(revocationSigningInput(QID, DHASH)).toString("hex")).toBe(
      "affd6504090e1d643114ff1e684d2b76e658415fc4e8949f1fe37d5706307182",
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
          "dGnBfOhWyo7S6PNqr0SUGPu5Lk1THJEZ80Wp3Y2+KTfGMR/zS4T9WknXFvwvxn1ma6y+7C9fGBZLGwoF7dhTBQ==",
      }),
    ).not.toThrow();

    expect(() =>
      verifyRevocationSignature({
        agentPubkeyBase64: AGENT_PUB,
        questionId: QID,
        delegationHashHex: DHASH,
        revocationSignatureBase64:
          "IRHlY3omUKleOAKchmQe+TwZ2Pdd1D7afshfNaA9B6fsGMmdZfDhukisxpwMnCa3ro9yGUNGSdDy4qp2vwEqDg==",
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
