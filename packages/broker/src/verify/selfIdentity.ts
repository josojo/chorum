// Registration-time Self proof verification (verify-once — ARCHITECTURE_V0.md §5).
//
// Runs at POST /v1/register only. For each proof in the EnrollmentBundle:
//   1. The self-bridge runs the real SNARK + the one-time on-chain Celo
//      registry/Merkle-root check (registryConfirmed).
//   2. Bindings: every proof is bound to agent_key (== userDefinedData) and
//      carries the SAME nullifier (-> unique_identifier).
//   3. The broker derives the authoritative disclosed_predicates (region,
//      country, age_band) from the verified nationality + satisfied thresholds.
//
// On success the caller binds nullifier -> agent_key and mints a DelegationToken.

import { type Settings, getSettings } from "../config";
import { type EnrollmentBundle, RejectionReason } from "../models";
import { BridgeError, type VerifySelfProof, verifySelfProof } from "./bridgeClient";
import { PredicateError, derivePredicates } from "./predicates";

export class VerifyEnrollmentError extends Error {
  reason: RejectionReason;
  detail: string;
  constructor(reason: RejectionReason, detail = "") {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "VerifyEnrollmentError";
    this.reason = reason;
    this.detail = detail;
  }
}

export interface VerifiedEnrollment {
  uniqueIdentifier: string;
  agentKey: string;
  disclosedPredicates: Record<string, string>;
}

function coerceThreshold(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

function isValid32ByteBase64(s: string): boolean {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) return false;
  return Buffer.from(s, "base64").length === 32;
}

// Verify every Self proof and derive the identity. Async (calls the bridge).
// `verifyProof` is injectable so tests can run without a real bridge.
export async function verifyEnrollment(
  bundle: EnrollmentBundle,
  opts: { settings?: Settings; verifyProof?: VerifySelfProof } = {},
): Promise<VerifiedEnrollment> {
  const settings = opts.settings ?? getSettings();
  const verifyProof = opts.verifyProof ?? verifySelfProof;

  // agent_key must be a usable 32-byte Ed25519 public key.
  if (!isValid32ByteBase64(bundle.agent_key)) {
    throw new VerifyEnrollmentError(
      RejectionReason.ENROLLMENT_MALFORMED,
      "agent_key invalid: not 32 bytes",
    );
  }

  let nullifier: string | null = null;
  let nationality: string | null = null;
  const satisfied: number[] = [];

  for (const sp of bundle.self_proofs) {
    let result;
    try {
      result = await verifyProof({
        bridgeUrl: settings.selfBridgeUrl,
        attestationId: sp.attestationId,
        proof: sp.proof,
        publicSignals: sp.publicSignals,
        userContextData: sp.userContextData,
        timeout: settings.selfVerifyTimeoutSeconds,
      });
    } catch (exc) {
      if (exc instanceof BridgeError) {
        throw new VerifyEnrollmentError(RejectionReason.SELF_BRIDGE_ERROR, String(exc));
      }
      throw exc;
    }

    if (!result.verified || !result.uniqueIdentifier) {
      throw new VerifyEnrollmentError(
        RejectionReason.SELF_PROOF_INVALID,
        "bridge reported proof did not verify",
      );
    }

    // Sybil hardening: the proof must be anchored to Self's live Celo registry.
    if (settings.requireRegistryConfirmation && !result.registryConfirmed) {
      throw new VerifyEnrollmentError(
        RejectionReason.SELF_REGISTRY_UNCONFIRMED,
        "on-chain registry/root not confirmed",
      );
    }

    // Agent-key bind (the proof commits to userDefinedData == agent_key).
    if (result.boundAgentKey !== null && result.boundAgentKey !== bundle.agent_key) {
      throw new VerifyEnrollmentError(
        RejectionReason.SELF_AGENT_BINDING_MISMATCH,
        "verified userDefinedData does not equal agent_key",
      );
    }

    // All proofs must be the same human (same scope ⇒ same nullifier).
    if (nullifier === null) {
      nullifier = result.uniqueIdentifier;
    } else if (result.uniqueIdentifier !== nullifier) {
      throw new VerifyEnrollmentError(
        RejectionReason.SELF_NULLIFIER_MISMATCH,
        "proofs carry different nullifiers",
      );
    }

    const nat = result.disclosed.nationality;
    if (nat) {
      if (nationality === null) {
        nationality = String(nat);
      } else if (String(nat) !== nationality) {
        throw new VerifyEnrollmentError(
          RejectionReason.SELF_PROOF_INVALID,
          "proofs disclose different nationalities",
        );
      }
    }

    const threshold = coerceThreshold(result.disclosed.older_than);
    if (threshold !== null) satisfied.push(threshold);
  }

  if (nullifier === null) {
    throw new VerifyEnrollmentError(RejectionReason.SELF_PROOF_INVALID, "no nullifier");
  }
  if (!nationality) {
    throw new VerifyEnrollmentError(
      RejectionReason.PREDICATE_DERIVATION_FAILED,
      "no nationality disclosed",
    );
  }

  let predicates: Record<string, string>;
  try {
    predicates = derivePredicates({ nationality, satisfiedThresholds: satisfied });
  } catch (exc) {
    if (exc instanceof PredicateError) {
      throw new VerifyEnrollmentError(RejectionReason.PREDICATE_DERIVATION_FAILED, String(exc));
    }
    throw exc;
  }

  return {
    uniqueIdentifier: nullifier,
    agentKey: bundle.agent_key,
    disclosedPredicates: predicates,
  };
}
