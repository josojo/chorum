// Account self-management — the data-subject right-to-erasure surface (issue
// #104). Positioned as privacy-first, Chorum must let a user delete their
// account, and the registry is keyed by the Self nullifier that ONLY the user
// holds (via their Self app) — so the user authenticates the deletion by
// re-proving that identity, exactly as they do for referral/board actions:
//
//   POST /v1/account/delete — verify the caller's live Self identity (agent
//     DelegationToken OR browser asker session, verify/identityAuth.ts), then
//     hard-delete every nullifier-keyed PII row and the caller's answers on
//     still-live questions (queries.deleteAccount). The live DelegationToken is
//     added to the revocation list so it dies immediately.
//
// "Deletion" is honest about what unlinkability already bought us: answers on
// CLOSED questions whose per-question secret was destroyed (ADR-098) can no
// longer be tied to the nullifier and are left as pure aggregate — they are no
// longer personal data. Everything still linkable is erased.

import type { FastifyInstance } from "fastify";

import type { Settings } from "../config";
import { getDb } from "../db";
import * as q from "../queries";
import {
  type AccountDeleteResponse,
  RejectionReason,
  accountDeleteRequestSchema,
} from "../models";
import { VerifyDelegationError, verifyDelegation } from "../verify/delegation";
import { authenticateIdentity } from "../verify/identityAuth";

export function registerAccountRoutes(
  app: FastifyInstance,
  opts: { settings: Settings },
): void {
  const { settings } = opts;
  const maybeReason = (reason: RejectionReason): string | null =>
    settings.exposeRejectionReasons ? reason : null;

  app.post("/v1/account/delete", async (req, reply) => {
    const parsed = accountDeleteRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(422).send({ detail: parsed.error.issues });
    }
    const db = getDb();

    let identity;
    try {
      identity = await authenticateIdentity(db, parsed.data, { settings });
    } catch (exc) {
      if (exc instanceof VerifyDelegationError) {
        req.log.info(`account delete: auth failed: ${exc.message}`);
        return reply.code(401).send({ error: maybeReason(exc.reason) });
      }
      throw exc;
    }

    const result = await q.deleteAccount(db, identity.uniqueIdentifier);

    // Kill the live agent token immediately so it can't outlive the account. The
    // asker-session path has no long-lived token (the session expires on its own).
    if (parsed.data.delegation_token) {
      const verified = verifyDelegation(parsed.data.delegation_token, { settings });
      await q.addRevocation(db, verified.delegationHash);
    }

    const body: AccountDeleteResponse = {
      deleted: true,
      registration_deleted: result.registrationDeleted,
      deleted_answers: result.deletedEnvelopes,
      affected_questions: result.affectedQuestions,
    };
    return reply.code(200).send(body);
  });
}
