// Shared test helpers — the vitest equivalents of conftest.py's fixtures.
//
// The one network call to the self-bridge (verifySelfProof) is replaced with a
// deterministic fake steered by a `_test` blob embedded in each proof. Everything
// else — bindings, predicate derivation, the broker signature, the DB constraints
// — runs for real.

import nacl from "tweetnacl";

import { issueDelegationToken } from "../src/verify/credential";
import { delegationHash } from "../src/verify/canonical";
import { envelopeSigningInput, revocationSigningInput } from "../src/verify/envelope";
import type { DelegationToken, Envelope, EnvelopeRevocation } from "../src/models";
import type { BridgeVerifyResult, VerifySelfProof } from "../src/verify/bridgeClient";

// ----- crypto -------------------------------------------------------------

export const agentKeyPair = nacl.sign.keyPair.fromSeed(
  new Uint8Array(Buffer.from("AGENT-KEY-FOR-HEARME-TESTING-32B")),
);
export const agentKeyB64 = Buffer.from(agentKeyPair.publicKey).toString("base64");

// ----- mocked self-bridge -------------------------------------------------

interface TestBlob {
  verified?: boolean;
  uniqueIdentifier?: string;
  nationality?: string;
  older_than?: number;
  registryConfirmed?: boolean;
  boundAgentKey?: string;
}

// Deterministic fake of verifySelfProof, driven by proof._test (see makeEnrollment).
export const mockVerifyProof: VerifySelfProof = async ({
  proof,
  userContextData,
}): Promise<BridgeVerifyResult> => {
  const t: TestBlob = ((proof as { _test?: TestBlob } | null)?._test ?? {}) as TestBlob;
  const disclosed: Record<string, unknown> = {};
  if (t.nationality != null) disclosed.nationality = t.nationality;
  if (t.older_than != null) disclosed.older_than = t.older_than;
  return {
    verified: t.verified ?? true,
    uniqueIdentifier: t.uniqueIdentifier ?? null,
    disclosed,
    boundAgentKey: t.boundAgentKey ?? userContextData,
    registryConfirmed: t.registryConfirmed ?? true,
  };
};

// ----- factories ----------------------------------------------------------

export function makeEnrollment(opts: {
  agentKey?: string;
  uniqueIdentifier?: string;
  nationality?: string;
  thresholds?: number[];
  verified?: boolean;
  registryConfirmed?: boolean;
  boundAgentKey?: string | null;
  perProofNullifier?: string[];
} = {}): { self_proofs: unknown[]; agent_key: string } {
  const ak = opts.agentKey ?? agentKeyB64;
  const thresholds = opts.thresholds ?? [18, 25, 35];
  const uid = opts.uniqueIdentifier ?? "self:nullifier-1";
  const proofs = thresholds.map((thr, i) => ({
    attestationId: 1,
    proof: {
      _test: {
        verified: opts.verified ?? true,
        uniqueIdentifier: opts.perProofNullifier ? opts.perProofNullifier[i] : uid,
        nationality: opts.nationality ?? "DE",
        older_than: thr,
        registryConfirmed: opts.registryConfirmed ?? true,
        boundAgentKey: opts.boundAgentKey !== undefined ? opts.boundAgentKey : ak,
      },
    },
    publicSignals: [],
    userContextData: ak,
  }));
  return { self_proofs: proofs, agent_key: ak };
}

export function makeToken(opts: {
  uniqueIdentifier?: string;
  disclosedPredicates?: Record<string, string>;
  issuedAt?: Date;
  expiresAt?: Date;
  agentKey?: string;
} = {}): DelegationToken {
  const now = Date.now();
  const uid =
    opts.uniqueIdentifier ?? "self:" + Buffer.alloc(32, 1).toString("base64");
  const preds = opts.disclosedPredicates ?? { region: "EU", age_band: "35-49" };
  return issueDelegationToken({
    unique_identifier: uid,
    disclosed_predicates: preds,
    agent_key: opts.agentKey ?? agentKeyB64,
    issued_at: opts.issuedAt ?? new Date(now - 24 * 60 * 60 * 1000),
    expires_at: opts.expiresAt ?? new Date(now + 89 * 24 * 60 * 60 * 1000),
  });
}

export function makeEnvelope(
  token: DelegationToken,
  args: { questionId: string; answer: string; nonce: string },
): Envelope {
  const dhash = delegationHash(token);
  const digest = envelopeSigningInput(args.questionId, args.answer, args.nonce, dhash);
  const sig = nacl.sign.detached(digest, agentKeyPair.secretKey);
  return {
    question_id: args.questionId,
    answer: args.answer,
    no_signal: false,
    nonce: args.nonce,
    delegation_token: token,
    agent_signature: Buffer.from(sig).toString("base64"),
  };
}

export function makeRevocation(
  token: DelegationToken,
  args: { questionId: string },
): EnvelopeRevocation {
  const dhash = delegationHash(token);
  const digest = revocationSigningInput(args.questionId, dhash);
  const sig = nacl.sign.detached(digest, agentKeyPair.secretKey);
  return {
    question_id: args.questionId,
    delegation_token: token,
    revocation_signature: Buffer.from(sig).toString("base64"),
  };
}
