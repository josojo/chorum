// POST /v1/envelopes — verify and persist (ARCHITECTURE_V0.md §5).
//
// Per-envelope pipeline. NO Self proof, NO bridge call at answer time.
//   2. Verify the broker's OWN signature on the token + expiry.
//   3. Registry: row for unique_identifier exists, binds the SAME agent_key, not
//      revoked. Also honor the legacy revocations table (by delegation_hash).
//   4. Recompute delegation_hash (in verifyDelegation).
//   5. Verify agent_signature over H(question_id || answer || nonce || delegation_hash).
//   6. Question exists, open, not closed, nonce matches, predicates eligible.
//   7. INSERT envelope (composite PK = duplicate rejection).
//   8. Increment the aggregate row.

import type { FastifyInstance } from "fastify";

import { classifyAnswer } from "../aggregates";
import { getSettings } from "../config";
import { getDb } from "../db";
import * as q from "../queries";
import { isScopeEligible } from "../eligibility";
import { type EnvelopeAck, RejectionReason, envelopeSchema } from "../models";
import { VerifyDelegationError, verifyDelegation } from "../verify/delegation";
import { VerifyEnvelopeError, verifyAgentSignature } from "../verify/envelope";
import { voterTagFor } from "../voterTag";

function ack(accepted: boolean, reason?: RejectionReason): EnvelopeAck {
  const settings = getSettings();
  if (!accepted && !settings.exposeRejectionReasons) {
    return { accepted: false, reason: null };
  }
  return { accepted, reason: reason ?? null };
}

export function registerEnvelopesRoutes(app: FastifyInstance): void {
  app.post("/v1/envelopes", async (req, reply) => {
    const parsed = envelopeSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(422).send({ detail: parsed.error.issues });
    }
    const envelope = parsed.data;

    // Steps 2 & 4: broker-signature + expiry (synchronous; no bridge).
    let verified;
    try {
      verified = verifyDelegation(envelope.delegation_token);
    } catch (exc) {
      if (exc instanceof VerifyDelegationError) {
        req.log.info(`delegation verify failed: ${exc.message}`);
        return ack(false, exc.reason);
      }
      throw exc;
    }

    const token = verified.token;
    const db = getDb();

    // Step 3a: legacy revocation list (by delegation_hash).
    if (await q.isRevoked(db, verified.delegationHash)) {
      return ack(false, RejectionReason.TOKEN_REVOKED);
    }

    // Step 3b: the identity must be a live registration bound to THIS agent_key.
    const registration = await q.getRegistration(db, verified.uniqueIdentifier);
    if (registration === null) return ack(false, RejectionReason.REGISTRATION_NOT_FOUND);
    if (registration.revokedAt !== null) return ack(false, RejectionReason.TOKEN_REVOKED);
    if (registration.agentKey !== token.agent_key) {
      return ack(false, RejectionReason.REGISTRATION_AGENT_MISMATCH);
    }

    // Step 6a: question exists / open / not closed / nonce / eligibility.
    const question = await q.getQuestionForVerify(db, envelope.question_id);
    if (question === null) return ack(false, RejectionReason.QUESTION_NOT_FOUND);
    if (question.status !== "open") return ack(false, RejectionReason.QUESTION_NOT_OPEN);
    if (question.closesAt.getTime() <= Date.now()) {
      return ack(false, RejectionReason.QUESTION_CLOSED);
    }
    if (question.nonce !== envelope.nonce) return ack(false, RejectionReason.NONCE_MISMATCH);
    if (!isScopeEligible({ question, disclosedPredicates: token.disclosed_predicates })) {
      return ack(false, RejectionReason.SCOPE_INELIGIBLE);
    }

    // Step 5: agent signature over the per-question payload.
    try {
      verifyAgentSignature({
        agentPubkeyBase64: token.agent_key,
        questionId: envelope.question_id,
        answer: envelope.answer,
        nonce: envelope.nonce,
        delegationHashHex: verified.delegationHash,
        agentSignatureBase64: envelope.agent_signature,
      });
    } catch (exc) {
      if (exc instanceof VerifyEnvelopeError) {
        req.log.info(`envelope verify failed: ${exc.message}`);
        return ack(false, exc.reason);
      }
      throw exc;
    }

    // Step 6b: a signal answer must select one of the question's options.
    // no_signal envelopes carry no opinion (answer is free / empty, §1.14) and
    // skip this gate. Rejecting here — rather than accepting and dropping the
    // vote into no bucket — keeps total_answers == sum(per-option buckets).
    if (!envelope.no_signal && classifyAnswer(envelope.answer, question.options) === null) {
      return ack(false, RejectionReason.ANSWER_UNCLASSIFIED);
    }

    // The envelope is stored under a per-question pseudonym, not the raw nullifier
    // (§1.4): voter_tag = HMAC(secret, question_id | nullifier). Deterministic, so
    // the composite PK still rejects a second answer from the same human to the
    // same question; unlinkable, so the answers table is no cross-question join key.
    const voterTag = voterTagFor(envelope.question_id, verified.uniqueIdentifier);

    // Steps 7-8 in a transaction so aggregates + per-person counters can't drift
    // from envelopes.
    let duplicate = false;
    await db.transaction(async (tx) => {
      const inserted = await q.insertEnvelope(tx, {
        questionId: envelope.question_id,
        voterTag,
        answer: envelope.answer,
        noSignal: envelope.no_signal,
        disclosedPredicates: token.disclosed_predicates,
        agentSignature: envelope.agent_signature,
        delegationHashHex: verified.delegationHash,
      });
      if (!inserted) {
        // Composite PK collision — DB-enforced one-answer-per-human.
        duplicate = true;
        return;
      }
      await q.incrementAggregate(tx, {
        questionId: envelope.question_id,
        answer: envelope.answer,
        disclosedPredicates: token.disclosed_predicates,
        options: question.options,
        noSignal: envelope.no_signal,
      });
      // Per-person tally on the registration (the answers table no longer holds a
      // stable per-person key, §1.4 / §14.2). Keyed by the raw nullifier.
      await q.adjustAnswerCounters(tx, {
        uniqueIdentifier: verified.uniqueIdentifier,
        delta: 1,
        signalDelta: envelope.no_signal ? 0 : 1,
      });
    });
    if (duplicate) return ack(false, RejectionReason.DUPLICATE);

    return ack(true);
  });
}
