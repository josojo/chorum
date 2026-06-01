// Asker login session — the browser-side counterpart of the DelegationToken.
//
// A DelegationToken is minted for an AGENT at POST /v1/register and binds an
// agent_key the browser never holds. But the asker gate (ARCHITECTURE.md §15.3)
// keys purely on the Self nullifier (unique_identifier): a person's answer
// score lives under their nullifier, not their token. So a human can prove that
// nullifier directly with a fresh "Sign in with Self" scan — the nullifier is
// deterministic per scope, so a re-scan re-derives the SAME identity the agent
// registered under.
//
// After the broker learns that nullifier from a verified scan (routes/askers.ts
// login/status, via the bridge it controls — NEVER from the browser), it mints
// this short-lived, broker-signed, identity-only session. The /ask form replays
// it on submit; the broker verifies its OWN signature and re-runs the gate. The
// browser cannot forge it, exactly as it cannot forge a DelegationToken.
//
// Signed payload: SHA-256(canonical_json(claims without broker_signature)),
// Ed25519 with the broker's signing key — the same primitive as credential.ts.

import { createHash } from "node:crypto";
import nacl from "tweetnacl";

import { type Settings, getSettings } from "../config";
import { type AskerSession, RejectionReason } from "../models";
import { canonicalJson } from "./canonical";
import { SCOPE, iso, loadSigningSeed } from "./credential";
import { VerifyDelegationError } from "./delegation";

// Short by design: the session only has to live from the verifying scan to the
// question submit a few minutes later. Re-verifying is a fresh scan away.
export const ASKER_SESSION_TTL_MS = 30 * 60 * 1000;

type SessionClaims = {
  version: 1;
  kind: "asker_session";
  scope: typeof SCOPE;
  unique_identifier: string;
  issued_at: string;
  expires_at: string;
};

function claims(args: {
  unique_identifier: string;
  issued_at: string;
  expires_at: string;
}): SessionClaims {
  return {
    version: 1,
    kind: "asker_session",
    scope: SCOPE,
    unique_identifier: args.unique_identifier,
    issued_at: args.issued_at,
    expires_at: args.expires_at,
  };
}

function payload(c: SessionClaims): Uint8Array {
  return new Uint8Array(createHash("sha256").update(canonicalJson(c)).digest());
}

// Mint and sign an asker session for a freshly Self-verified identity.
export function issueAskerSession(args: {
  unique_identifier: string;
  issued_at: Date | string;
  expires_at: Date | string;
  settings?: Settings;
}): AskerSession {
  const settings = args.settings ?? getSettings();
  const keyPair = nacl.sign.keyPair.fromSeed(loadSigningSeed(settings));
  const c = claims({
    unique_identifier: args.unique_identifier,
    issued_at: iso(args.issued_at),
    expires_at: iso(args.expires_at),
  });
  const sig = nacl.sign.detached(payload(c), keyPair.secretKey);
  return { ...c, broker_signature: Buffer.from(sig).toString("base64") };
}

// Verify a session is one THIS broker minted and is unexpired; return the
// identity it carries. Throws VerifyDelegationError (same reasons as the token
// path) so callers handle auth failure uniformly.
export function verifyAskerSession(
  session: AskerSession,
  opts: { now?: Date; settings?: Settings } = {},
): { uniqueIdentifier: string } {
  const settings = opts.settings ?? getSettings();
  const keyPair = nacl.sign.keyPair.fromSeed(loadSigningSeed(settings));
  const c = claims({
    unique_identifier: session.unique_identifier,
    issued_at: session.issued_at,
    expires_at: session.expires_at,
  });

  let sig: Buffer;
  try {
    sig = Buffer.from(session.broker_signature, "base64");
  } catch {
    throw new VerifyDelegationError(RejectionReason.BROKER_SIGNATURE_INVALID);
  }
  if (
    sig.length !== 64 ||
    !nacl.sign.detached.verify(payload(c), new Uint8Array(sig), keyPair.publicKey)
  ) {
    throw new VerifyDelegationError(
      RejectionReason.BROKER_SIGNATURE_INVALID,
      "asker_session signature does not verify against the broker key",
    );
  }

  const now = opts.now ?? new Date();
  if (new Date(session.expires_at).getTime() <= now.getTime()) {
    throw new VerifyDelegationError(
      RejectionReason.TOKEN_EXPIRED,
      `expires_at=${session.expires_at} now=${now.toISOString()}`,
    );
  }

  return { uniqueIdentifier: session.unique_identifier };
}
