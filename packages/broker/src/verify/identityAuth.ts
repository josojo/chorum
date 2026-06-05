// Shared identity authentication for the durable account actions added by the
// referral/board system (REFERRALS.md). Both the agent (which holds a 90-day
// DelegationToken) and a browser asker (which holds a short "Sign in with Self"
// session) need to prove the SAME thing these endpoints care about: a live,
// non-revoked Self identity, resolved to its nullifier. This collapses the two
// auth paths the asker routes already use (routes/askers.ts) into one helper so
// referral-create, referral-stats, and board-claim all gate identically.
//
// Returns the verified nullifier; throws VerifyDelegationError (same reasons the
// asker paths surface) on any auth failure, so callers handle it uniformly.

import { type Settings, getSettings } from "../config";
import type { Db } from "../db";
import { type AskerSession, type DelegationToken, RejectionReason } from "../models";
import * as q from "../queries";
import { VerifyDelegationError, verifyDelegation } from "./delegation";
import { verifyAskerSession } from "./askerSession";

export interface IdentityCredentials {
  delegation_token?: DelegationToken | null;
  asker_session?: AskerSession | null;
}

// Authenticate one of the two credential forms and return the live identity.
// The DelegationToken path mirrors POST /v1/askers/eligibility step 2 (registry
// lookup + agent-key binding); the asker-session path mirrors session/verify.
export async function authenticateIdentity(
  db: Db,
  creds: IdentityCredentials,
  opts: { settings?: Settings; now?: Date } = {},
): Promise<{ uniqueIdentifier: string }> {
  const settings = opts.settings ?? getSettings();

  if (creds.delegation_token) {
    const verified = verifyDelegation(creds.delegation_token, { settings, now: opts.now });
    if (await q.isRevoked(db, verified.delegationHash)) {
      throw new VerifyDelegationError(RejectionReason.TOKEN_REVOKED);
    }
    const registration = await q.getRegistration(db, verified.uniqueIdentifier);
    if (registration === null) {
      throw new VerifyDelegationError(RejectionReason.REGISTRATION_NOT_FOUND);
    }
    if (registration.revokedAt !== null) {
      throw new VerifyDelegationError(RejectionReason.TOKEN_REVOKED);
    }
    if (registration.agentKey !== verified.token.agent_key) {
      throw new VerifyDelegationError(RejectionReason.REGISTRATION_AGENT_MISMATCH);
    }
    if (await q.isSelfNullifierInvalidated(db, verified.uniqueIdentifier)) {
      throw new VerifyDelegationError(RejectionReason.IDENTITY_REVOKED);
    }
    return { uniqueIdentifier: verified.uniqueIdentifier };
  }

  if (creds.asker_session) {
    const identity = verifyAskerSession(creds.asker_session, { settings, now: opts.now });
    if (await q.isSelfNullifierInvalidated(db, identity.uniqueIdentifier)) {
      throw new VerifyDelegationError(RejectionReason.IDENTITY_REVOKED);
    }
    return { uniqueIdentifier: identity.uniqueIdentifier };
  }

  // Neither credential present — routes validate this with zod before calling,
  // so this is a defensive fallback, not the normal path.
  throw new VerifyDelegationError(
    RejectionReason.BROKER_SIGNATURE_INVALID,
    "no credential provided",
  );
}
