// POST /v1/askers/eligibility — authenticated asker gating decision.
//
// The v0 asker auth + unlock threshold of the answer-credit economy
// (ARCHITECTURE.md §15.3). The asker proves a registered identity by presenting
// their broker-signed DelegationToken; the broker authenticates it (the same
// trust path as POST /v1/envelopes, steps 2-3: broker signature + expiry + a
// live, non-revoked registration bound to the same agent_key) and then reports
// whether that identity clears the unlock threshold.
//
// v0 asker auth is possession of the credential (a broker-signed, unexpired,
// live token). It is NOT yet proof-of-private-key: a per-request challenge or a
// signature over the question payload (mirroring the envelope agent_signature)
// is the documented hardening (§15.3 / §11). We take the token rather than a
// bare unique_identifier precisely so this is authentication, not an open oracle
// of anyone's answer counts.
//
// Only the broker can read envelopes + registrations (db/init/02-roles.sh), so
// both the auth and the count must live here. The web /ask flow calls this
// before inserting a question and blocks when can_ask is false.

import type { FastifyInstance } from "fastify";

import { getDb } from "../db";
import * as q from "../queries";
import type { Settings } from "../config";
import {
  evaluateAskerEligibility,
  parseAdminIdentifiers,
} from "../askerGating";
import {
  type AskerEligibilityResponse,
  RejectionReason,
  askerEligibilityRequestSchema,
} from "../models";
import { VerifyDelegationError, verifyDelegation } from "../verify/delegation";

export function registerAskersRoutes(
  app: FastifyInstance,
  opts: { settings: Settings },
): void {
  const { settings } = opts;
  const admins = parseAdminIdentifiers(settings.askerAdminIdentifiers);
  const requiredTotal = settings.askerUnlockTotalAnswers;
  const requiredSignal = settings.askerUnlockSignalAnswers;

  // Auth failure: zero gate fields, surface the reason only when the broker is
  // configured to expose rejection reasons (avoid being an oracle, §5).
  function unauthorized(reason: RejectionReason): AskerEligibilityResponse {
    return {
      authorized: false,
      auth_reason: settings.exposeRejectionReasons ? reason : null,
      unique_identifier: null,
      can_ask: false,
      is_admin: false,
      total_answers: 0,
      signal_answers: 0,
      required_total: requiredTotal,
      required_signal: requiredSignal,
      remaining_total: requiredTotal,
      remaining_signal: requiredSignal,
      reason: null,
    };
  }

  app.post("/v1/askers/eligibility", async (req, reply) => {
    const parsed = askerEligibilityRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(422).send({ detail: parsed.error.issues });
    }
    const token = parsed.data.delegation_token;

    // Step 1: broker signature + expiry (synchronous; no bridge, no Self proof).
    let verified;
    try {
      verified = verifyDelegation(token);
    } catch (exc) {
      if (exc instanceof VerifyDelegationError) {
        req.log.info(`asker auth: delegation verify failed: ${exc.message}`);
        return unauthorized(exc.reason);
      }
      throw exc;
    }

    const db = getDb();

    // Step 2: the identity must back a live registration bound to THIS agent_key,
    // and must not be revoked (legacy list, registry flag, or Self invalidation).
    if (await q.isRevoked(db, verified.delegationHash)) {
      return unauthorized(RejectionReason.TOKEN_REVOKED);
    }
    const registration = await q.getRegistration(db, verified.uniqueIdentifier);
    if (registration === null) {
      return unauthorized(RejectionReason.REGISTRATION_NOT_FOUND);
    }
    if (registration.revokedAt !== null) {
      return unauthorized(RejectionReason.TOKEN_REVOKED);
    }
    if (registration.agentKey !== token.agent_key) {
      return unauthorized(RejectionReason.REGISTRATION_AGENT_MISMATCH);
    }
    if (await q.isSelfNullifierInvalidated(db, verified.uniqueIdentifier)) {
      return unauthorized(RejectionReason.IDENTITY_REVOKED);
    }

    // Authenticated. Now the gate: does this identity clear the unlock threshold?
    const counts = await q.askerAnswerCounts(db, verified.uniqueIdentifier);
    const result = evaluateAskerEligibility({
      counts,
      thresholds: { requiredTotal, requiredSignal },
      isAdmin: admins.has(verified.uniqueIdentifier),
    });

    const body: AskerEligibilityResponse = {
      authorized: true,
      auth_reason: null,
      unique_identifier: verified.uniqueIdentifier,
      can_ask: result.canAsk,
      is_admin: result.isAdmin,
      total_answers: result.totalAnswers,
      signal_answers: result.signalAnswers,
      required_total: result.requiredTotal,
      required_signal: result.requiredSignal,
      remaining_total: result.remainingTotal,
      remaining_signal: result.remainingSignal,
      reason: result.reason,
    };
    return body;
  });
}
