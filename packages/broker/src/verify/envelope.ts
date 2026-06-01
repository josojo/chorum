// Agent signature verification + request linkage.
//
// ARCHITECTURE.md §8.5:
//   agent_signature = Sign(agent_key, H(question_id || answer || nonce || delegation_hash))
//
// The byte-level wire format: the four components joined with a single ASCII `|`
// separator (which cannot appear in a UUID, hex hash, or base64 nonce), then
// SHA-256 hashed so the signed message is a fixed 32 bytes. This is mirrored
// byte-for-byte in hearme-skill — both signers and verifiers MUST agree.
//
// Per-envelope override (§1.12): a user retracts one answer by signing a
// *revocation* over a domain-separated input:
//   revocation_signature = Sign(agent_key, H("REVOKE" | question_id | delegation_hash))
// The literal "REVOKE" prefix is the domain separator, so a captured envelope
// signature cannot be replayed as a revocation and vice versa.

import { createHash } from "node:crypto";
import nacl from "tweetnacl";

import { RejectionReason } from "../models";

export class VerifyEnvelopeError extends Error {
  reason: RejectionReason;
  detail: string;
  constructor(reason: RejectionReason, detail = "") {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "VerifyEnvelopeError";
    this.reason = reason;
    this.detail = detail;
  }
}

const SEP = Buffer.from("|");
const REVOKE_DOMAIN = Buffer.from("REVOKE");

// base64.b64decode(s, validate=True) equivalent: reject anything outside the
// base64 alphabet so genuinely malformed input is rejected as the right reason.
function decodeBase64Strict(s: string): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) {
    throw new Error("invalid base64");
  }
  return Buffer.from(s, "base64");
}

// Return the exact bytes the agent_key signs.
export function envelopeSigningInput(
  questionId: string,
  answer: string,
  nonce: string,
  delegationHashHex: string,
): Uint8Array {
  const parts = [String(questionId), answer, nonce, delegationHashHex].map((p) =>
    Buffer.from(p, "utf-8"),
  );
  const raw = Buffer.concat([parts[0], SEP, parts[1], SEP, parts[2], SEP, parts[3]]);
  return new Uint8Array(createHash("sha256").update(raw).digest());
}

// Return the exact bytes the agent_key signs to revoke ONE answer.
export function revocationSigningInput(
  questionId: string,
  delegationHashHex: string,
): Uint8Array {
  const raw = Buffer.concat([
    REVOKE_DOMAIN,
    SEP,
    Buffer.from(String(questionId), "utf-8"),
    SEP,
    Buffer.from(delegationHashHex, "utf-8"),
  ]);
  return new Uint8Array(createHash("sha256").update(raw).digest());
}

function decodeKeyAndSig(
  agentPubkeyBase64: string,
  signatureBase64: string,
): { pubkey: Uint8Array; signature: Uint8Array } {
  let pubkey: Buffer;
  try {
    pubkey = decodeBase64Strict(agentPubkeyBase64);
  } catch (exc) {
    throw new VerifyEnvelopeError(
      RejectionReason.AGENT_KEY_INVALID,
      `base64 decode failed: ${exc}`,
    );
  }
  if (pubkey.length !== 32) {
    throw new VerifyEnvelopeError(
      RejectionReason.AGENT_KEY_INVALID,
      `agent_key is ${pubkey.length} bytes; want 32`,
    );
  }
  let signature: Buffer;
  try {
    signature = decodeBase64Strict(signatureBase64);
  } catch (exc) {
    throw new VerifyEnvelopeError(
      RejectionReason.AGENT_SIGNATURE_INVALID,
      `base64 decode failed: ${exc}`,
    );
  }
  if (signature.length !== 64) {
    throw new VerifyEnvelopeError(
      RejectionReason.AGENT_SIGNATURE_INVALID,
      `signature is ${signature.length} bytes; want 64`,
    );
  }
  return { pubkey: new Uint8Array(pubkey), signature: new Uint8Array(signature) };
}

// Raise VerifyEnvelopeError on any signature/key/linkage failure. Any swap of
// question_id/answer/nonce/delegation_hash changes the digest and fails here.
export function verifyAgentSignature(args: {
  agentPubkeyBase64: string;
  questionId: string;
  answer: string;
  nonce: string;
  delegationHashHex: string;
  agentSignatureBase64: string;
}): void {
  const { pubkey, signature } = decodeKeyAndSig(
    args.agentPubkeyBase64,
    args.agentSignatureBase64,
  );
  const digest = envelopeSigningInput(
    args.questionId,
    args.answer,
    args.nonce,
    args.delegationHashHex,
  );
  if (!nacl.sign.detached.verify(digest, signature, pubkey)) {
    throw new VerifyEnvelopeError(
      RejectionReason.AGENT_SIGNATURE_INVALID,
      "agent signature does not verify",
    );
  }
}

// Mirror of verifyAgentSignature over the revocation digest. Reuses the AGENT_*
// reason codes because the failure mode is identical.
export function verifyRevocationSignature(args: {
  agentPubkeyBase64: string;
  questionId: string;
  delegationHashHex: string;
  revocationSignatureBase64: string;
}): void {
  const { pubkey, signature } = decodeKeyAndSig(
    args.agentPubkeyBase64,
    args.revocationSignatureBase64,
  );
  const digest = revocationSigningInput(args.questionId, args.delegationHashHex);
  if (!nacl.sign.detached.verify(digest, signature, pubkey)) {
    throw new VerifyEnvelopeError(
      RejectionReason.AGENT_SIGNATURE_INVALID,
      "revocation signature does not verify",
    );
  }
}
