// Broker-issued session credential (the DelegationToken).
//
// Verify-once (ARCHITECTURE.md §5/§8): after the broker verifies the Self proofs
// at POST /v1/register, it mints a DelegationToken signed by its own Ed25519 key.
// The agent replays that token per answer; the broker verifies its OWN signature
// — no Self proof, no bridge call at answer time.
//
// The signed message is SHA-256(canonical_json(token claims without
// broker_signature)). issue and verifyBrokerSignature build that claims object
// the same way, from the SAME timestamp STRINGS, so they always agree — and the
// strings equal what the Python broker signed, so Python-issued tokens verify
// here too. tweetnacl == NaCl == pynacl (standard, deterministic Ed25519).

import { createHash } from "node:crypto";
import nacl from "tweetnacl";

import { type Settings, getSettings } from "../config";
import type { DelegationToken } from "../models";
import { canonicalJson } from "./canonical";

export const SCOPE = "hearme-v1";

function loadSigningSeed(settings: Settings): Uint8Array {
  const seed = Buffer.from(settings.brokerSigningKey, "base64");
  if (seed.length !== 32) {
    throw new Error(
      `HEARME_BROKER_SIGNING_KEY decodes to ${seed.length} bytes; want 32`,
    );
  }
  return new Uint8Array(seed);
}

// Format a Date the way Python's datetime.isoformat().replace("+00:00","Z") does:
// drop the fractional part when sub-second is zero, otherwise 6-digit microseconds.
// A plain string is returned verbatim (it is already the canonical wire form).
export function iso(value: Date | string): string {
  if (typeof value === "string") return value;
  const s = value.toISOString(); // YYYY-MM-DDTHH:mm:ss.sssZ
  if (value.getUTCMilliseconds() === 0) {
    return s.replace(/\.\d{3}Z$/, "Z");
  }
  return s.replace(/\.(\d{3})Z$/, ".$1000Z");
}

type Claims = {
  version: 2;
  scope: typeof SCOPE;
  unique_identifier: string;
  disclosed_predicates: Record<string, string>;
  agent_key: string;
  issued_at: string;
  expires_at: string;
};

// Token claims WITHOUT broker_signature — the signed payload's source.
function claims(args: {
  unique_identifier: string;
  disclosed_predicates: Record<string, string>;
  agent_key: string;
  issued_at: string;
  expires_at: string;
}): Claims {
  return {
    version: 2,
    scope: SCOPE,
    unique_identifier: args.unique_identifier,
    disclosed_predicates: args.disclosed_predicates,
    agent_key: args.agent_key,
    issued_at: args.issued_at,
    expires_at: args.expires_at,
  };
}

function payload(c: Claims): Uint8Array {
  return new Uint8Array(createHash("sha256").update(canonicalJson(c)).digest());
}

// Mint and sign a DelegationToken for a freshly verified identity.
export function issueDelegationToken(args: {
  unique_identifier: string;
  disclosed_predicates: Record<string, string>;
  agent_key: string;
  issued_at: Date | string;
  expires_at: Date | string;
  settings?: Settings;
}): DelegationToken {
  const settings = args.settings ?? getSettings();
  const seed = loadSigningSeed(settings);
  const keyPair = nacl.sign.keyPair.fromSeed(seed);
  const c = claims({
    unique_identifier: args.unique_identifier,
    disclosed_predicates: args.disclosed_predicates,
    agent_key: args.agent_key,
    issued_at: iso(args.issued_at),
    expires_at: iso(args.expires_at),
  });
  const sig = nacl.sign.detached(payload(c), keyPair.secretKey);
  return { ...c, broker_signature: Buffer.from(sig).toString("base64") };
}

// True iff token.broker_signature is a valid signature by THIS broker.
export function verifyBrokerSignature(
  token: DelegationToken,
  settings?: Settings,
): boolean {
  const s = settings ?? getSettings();
  const seed = loadSigningSeed(s);
  const keyPair = nacl.sign.keyPair.fromSeed(seed);
  const c = claims({
    unique_identifier: token.unique_identifier,
    disclosed_predicates: token.disclosed_predicates,
    agent_key: token.agent_key,
    issued_at: token.issued_at,
    expires_at: token.expires_at,
  });
  let sig: Buffer;
  try {
    sig = Buffer.from(token.broker_signature, "base64");
  } catch {
    return false;
  }
  if (sig.length !== 64) return false;
  return nacl.sign.detached.verify(payload(c), new Uint8Array(sig), keyPair.publicKey);
}
