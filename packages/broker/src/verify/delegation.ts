// Per-envelope DelegationToken verification (ARCHITECTURE_V0.md §5).
//
// The answer-time path. It does NOT touch a Self proof or the bridge — the proof
// was verified once at registration. Steps:
//   1. Verify the broker's OWN signature on the token (integrity).
//   2. Check expires_at > now().
//
// The caller then does the DB-backed checks (registrations registry lookup, the
// legacy revocations table, the agent's per-question signature, uniqueness) —
// see routes/envelopes.ts. delegation_hash (over the whole token,
// broker_signature included) is computed here so the caller doesn't recompute it.

import { type Settings, getSettings } from "../config";
import { type DelegationToken, RejectionReason } from "../models";
import { canonicalJson, delegationHash } from "./canonical";
import { verifyBrokerSignature } from "./credential";

export class VerifyDelegationError extends Error {
  reason: RejectionReason;
  detail: string;
  constructor(reason: RejectionReason, detail = "") {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "VerifyDelegationError";
    this.reason = reason;
    this.detail = detail;
  }
}

export interface VerifiedDelegation {
  token: DelegationToken;
  delegationHash: string;
  canonicalBytes: Buffer;
  uniqueIdentifier: string;
  disclosed: Record<string, string>;
}

export function checkExpiry(token: DelegationToken, now?: Date): void {
  const moment = now ?? new Date();
  const expiresAt = new Date(token.expires_at);
  if (expiresAt.getTime() <= moment.getTime()) {
    throw new VerifyDelegationError(
      RejectionReason.TOKEN_EXPIRED,
      `expires_at=${token.expires_at} now=${moment.toISOString()}`,
    );
  }
}

// Per-envelope token verification. Synchronous — no bridge, no proof. Returns a
// VerifiedDelegation carrying the canonical hash so the caller can do the
// registry/revocation lookups and the agent-signature check without recomputing.
export function verifyDelegation(
  token: DelegationToken,
  opts: { now?: Date; settings?: Settings } = {},
): VerifiedDelegation {
  const settings = opts.settings ?? getSettings();

  // Step 0: the token's scope must be this environment's frozen scope. A
  // mismatch (e.g. a staging token — scope "staging-chorum-v1" — replayed
  // against prod) is rejected before any crypto. The scope is also bound into
  // the signature below, but this gives a precise reason and an early, cheap
  // cross-environment barrier even if signing keys were ever shared (GH #97).
  if (token.scope !== settings.selfScope) {
    throw new VerifyDelegationError(
      RejectionReason.SELF_SCOPE_MISMATCH,
      `token scope '${token.scope}' != broker scope '${settings.selfScope}'`,
    );
  }

  // Step 1: the token must be one THIS broker minted.
  if (!verifyBrokerSignature(token, settings)) {
    throw new VerifyDelegationError(
      RejectionReason.BROKER_SIGNATURE_INVALID,
      "broker_signature does not verify against the broker key",
    );
  }

  // Step 2: not expired.
  checkExpiry(token, opts.now);

  return {
    token,
    delegationHash: delegationHash(token),
    canonicalBytes: canonicalJson(token),
    uniqueIdentifier: token.unique_identifier,
    disclosed: token.disclosed_predicates,
  };
}
