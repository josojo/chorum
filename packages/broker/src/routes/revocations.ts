// POST /v1/envelopes/revoke — per-answer override (§1.12 "override is sacred").
//
// A user retracts ONE of their own envelopes for ONE question. The broker:
//   1. Verifies its own signature on delegation_token + expiry (same as the
//      envelope path). The token is the only identifier; no unique_identifier
//      is accepted on the wire.
//   2. Honors the legacy revocation list (delegation_hash) and the registrations
//      registry — a revoked or unbound token cannot retract.
//   3. Verifies the user's Ed25519 signature over the *revocation* digest —
//      domain-separated from the envelope digest by the "REVOKE" prefix.
//   4. Atomically DELETEs the envelope for (question_id, token.unique_identifier)
//      and rebuilds the question's aggregate from the remaining envelopes.
//
// Idempotent: revoking an already-revoked or never-submitted answer returns
// accepted=true, found=false. Permitted regardless of question status/closes_at.

import type { FastifyInstance } from "fastify";

import { getSettings } from "../config";
import { getDb } from "../db";
import * as q from "../queries";
import { type RevocationAck, RejectionReason, envelopeRevocationSchema } from "../models";
import { VerifyDelegationError, verifyDelegation } from "../verify/delegation";
import { VerifyEnvelopeError, verifyRevocationSignature } from "../verify/envelope";
import { voterTagIfLive } from "../voterTag";

function ack(
  accepted: boolean,
  reason?: RejectionReason | null,
  found?: boolean | null,
): RevocationAck {
  const settings = getSettings();
  if (!settings.exposeRejectionReasons) {
    // Production posture: never tell callers whether an answer existed, and never
    // expose a specific rejection reason.
    return { accepted, reason: null, found: null };
  }
  return { accepted, reason: reason ?? null, found: found ?? null };
}

export function registerRevocationsRoutes(app: FastifyInstance): void {
  app.post("/v1/envelopes/revoke", async (req, reply) => {
    const parsed = envelopeRevocationSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(422).send({ detail: parsed.error.issues });
    }
    const revocation = parsed.data;

    // Step 1 + 2a: broker-signature + expiry (synchronous, no bridge call).
    let verified;
    try {
      verified = verifyDelegation(revocation.delegation_token);
    } catch (exc) {
      if (exc instanceof VerifyDelegationError) {
        req.log.info(`revocation: delegation verify failed: ${exc.message}`);
        return ack(false, exc.reason);
      }
      throw exc;
    }

    const token = verified.token;
    const db = getDb();

    // Step 2b: legacy revocation list — a revoked token cannot revoke.
    if (await q.isRevoked(db, verified.delegationHash)) {
      return ack(false, RejectionReason.TOKEN_REVOKED);
    }

    // Step 2c: live registration bound to THIS agent_key.
    const registration = await q.getRegistration(db, verified.uniqueIdentifier);
    if (registration === null) return ack(false, RejectionReason.REGISTRATION_NOT_FOUND);
    if (registration.revokedAt !== null) return ack(false, RejectionReason.TOKEN_REVOKED);
    if (registration.agentKey !== token.agent_key) {
      return ack(false, RejectionReason.REGISTRATION_AGENT_MISMATCH);
    }

    // Step 3: the user's signature over the revocation digest.
    try {
      verifyRevocationSignature({
        agentPubkeyBase64: token.agent_key,
        questionId: revocation.question_id,
        delegationHashHex: verified.delegationHash,
        revocationSignatureBase64: revocation.revocation_signature,
      });
    } catch (exc) {
      if (exc instanceof VerifyEnvelopeError) {
        req.log.info(`revocation: signature verify failed: ${exc.message}`);
        return ack(false, exc.reason);
      }
      throw exc;
    }

    // Step 4: delete the envelope and rebuild this question's aggregate. The row
    // is keyed by the per-question voter tag (§1.4); we re-derive it from the
    // verified nullifier + question_id, and also pass the nullifier so the
    // registration's answer counters roll back. If the question's secret was
    // already destroyed (closed past grace, ADR-098), the tag can no longer be
    // reproduced — the answer is unreachable, so this is an idempotent not-found.
    const voterTag = await voterTagIfLive(revocation.question_id, verified.uniqueIdentifier);
    if (voterTag === null) {
      return ack(true, RejectionReason.ENVELOPE_NOT_FOUND, false);
    }
    const found = await q.deleteOneEnvelopeAndRecompute(db, {
      questionId: revocation.question_id,
      voterTag,
      uniqueIdentifier: verified.uniqueIdentifier,
    });

    return ack(true, found ? null : RejectionReason.ENVELOPE_NOT_FOUND, found);
  });
}
