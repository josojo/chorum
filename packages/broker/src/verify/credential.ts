// Broker-issued session credential (the DelegationToken).
//
// Verify-once (ARCHITECTURE_V0.md §5/§8): after the broker verifies the Self proofs
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
import type { BoardCredential, DelegationToken } from "../models";
import { canonicalJson } from "./canonical";

// The `scope` claim is resolved per-environment and FROZEN in production (see
// verify/scope.ts and config.ts → settings.selfScope). It must equal the
// self-bridge's SELF_SCOPE, since the nullifier it accompanies is derived under
// that scope. issue/verify below take the scope from settings so a staging
// credential (scope "staging-chorum-v1") can never be confused with a prod one
// ("chorum-v1"). docs/DEPLOYMENT.md "Frozen constants — never change in prod".

export function loadSigningSeed(settings: Settings): Uint8Array {
  const seed = Buffer.from(settings.brokerSigningKey, "base64");
  if (seed.length !== 32) {
    throw new Error(
      `CHORUM_BROKER_SIGNING_KEY decodes to ${seed.length} bytes; want 32`,
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
  scope: string;
  unique_identifier: string;
  disclosed_predicates: Record<string, string>;
  agent_key: string;
  issued_at: string;
  expires_at: string;
};

// Token claims WITHOUT broker_signature — the signed payload's source. `scope` is
// the env-resolved settings.selfScope so the signature is bound to it.
function claims(args: {
  scope: string;
  unique_identifier: string;
  disclosed_predicates: Record<string, string>;
  agent_key: string;
  issued_at: string;
  expires_at: string;
}): Claims {
  return {
    version: 2,
    scope: args.scope,
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
    scope: settings.selfScope,
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
    scope: s.selfScope,
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

// ----- board credential (governance, REFERRALS.md §6) --------------------

// The governance scope, derived from (and distinct from) the answer scope, so a
// board credential / action can never be confused with answer-time identity and
// the two are unlinkable by scope. "chorum-v1" → "chorum-gov-v1"; staging's
// "staging-chorum-v1" → "staging-chorum-gov-v1". Frozen per env like selfScope.
export function governanceScope(selfScope: string): string {
  return selfScope.replace("chorum-", "chorum-gov-");
}

type BoardClaims = {
  version: 1;
  kind: "board_credential";
  scope: string;
  gov_key: string;
  tier: string;
  issued_at: string;
  expires_at: string;
};

function boardClaims(args: {
  scope: string;
  gov_key: string;
  tier: string;
  issued_at: string;
  expires_at: string;
}): BoardClaims {
  return {
    version: 1,
    kind: "board_credential",
    scope: args.scope,
    gov_key: args.gov_key,
    tier: args.tier,
    issued_at: args.issued_at,
    expires_at: args.expires_at,
  };
}

function boardPayload(c: BoardClaims): Uint8Array {
  return new Uint8Array(createHash("sha256").update(canonicalJson(c)).digest());
}

// Mint a broker-signed board credential. Crucially it binds the holder's FRESH
// governance key (gov_key) and tier — NOT the nullifier — under the governance
// scope, so board actions performed with gov_key don't link to the member's
// answers or passport identity (REFERRALS.md §6.1). Same Ed25519 primitive as
// the DelegationToken.
export function issueBoardCredential(args: {
  gov_key: string;
  tier: string;
  issued_at: Date | string;
  expires_at: Date | string;
  settings?: Settings;
}): BoardCredential {
  const settings = args.settings ?? getSettings();
  const keyPair = nacl.sign.keyPair.fromSeed(loadSigningSeed(settings));
  const c = boardClaims({
    scope: governanceScope(settings.selfScope),
    gov_key: args.gov_key,
    tier: args.tier,
    issued_at: iso(args.issued_at),
    expires_at: iso(args.expires_at),
  });
  const sig = nacl.sign.detached(boardPayload(c), keyPair.secretKey);
  return { ...c, broker_signature: Buffer.from(sig).toString("base64") };
}

// True iff `cred` is a valid, in-scope board credential signed by THIS broker.
// (Provided for verifiers of board actions; the claim endpoint mints, it does
// not verify.) Does not check expiry — callers decide on freshness.
export function verifyBoardCredential(
  cred: BoardCredential,
  settings?: Settings,
): boolean {
  const s = settings ?? getSettings();
  if (cred.scope !== governanceScope(s.selfScope)) return false;
  const keyPair = nacl.sign.keyPair.fromSeed(loadSigningSeed(s));
  const c = boardClaims({
    scope: cred.scope,
    gov_key: cred.gov_key,
    tier: cred.tier,
    issued_at: cred.issued_at,
    expires_at: cred.expires_at,
  });
  let sig: Buffer;
  try {
    sig = Buffer.from(cred.broker_signature, "base64");
  } catch {
    return false;
  }
  if (sig.length !== 64) return false;
  return nacl.sign.detached.verify(boardPayload(c), new Uint8Array(sig), keyPair.publicKey);
}
