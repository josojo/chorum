// POST /v1/envelopes — verify and persist (ARCHITECTURE_V0.md §5).
//
// Per-envelope pipeline. NO Self proof, NO bridge call at answer time.
//   2. Verify the broker's OWN signature on the token + expiry.
//   3. Registry: row for unique_identifier exists, binds the SAME agent_key, not
//      revoked. Also honor the legacy revocations table (by delegation_hash).
//   4. Recompute delegation_hash (in verifyDelegation).
//   5. Verify agent_signature over H(question_id || answer || nonce || delegation_hash).
//   6. Question exists, open, not closed, nonce matches, predicates eligible.
//   7. INSERT envelope; on composite-PK collision, override the earlier answer
//      in place (re-submission replaces, never duplicates).
//   8. Increment the aggregate row (or rebuild it after an override).

import type { FastifyInstance } from "fastify";

import { classifyAnswer } from "../aggregates";
import { getSettings } from "../config";
import { getDb } from "../db";
import { recordOutcome } from "../observability/metrics";
import * as q from "../queries";
import { isScopeEligible } from "../eligibility";
import { type EnvelopeAck, RejectionReason, envelopeSchema } from "../models";
import { VerifyDelegationError, verifyDelegation } from "../verify/delegation";
import { VerifyEnvelopeError, verifyAgentSignature } from "../verify/envelope";
import { voterTagForInsert } from "../voterTag";

function ack(accepted: boolean, reason?: RejectionReason): EnvelopeAck {
  // Record the TRUE outcome/reason before the expose gate (see register.ts).
  recordOutcome("envelopes", accepted, reason);
  const settings = getSettings();
  if (!accepted && !settings.exposeRejectionReasons) {
    return { accepted: false, reason: null };
  }
  return { accepted, reason: reason ?? null };
}

export function registerEnvelopesRoutes(app: FastifyInstance): void {
  app.post("/v1/envelopes", async (req, reply) => {
    const settings = getSettings();
    const parsed = envelopeSchema.safeParse(req.body);
    if (!parsed.success) {
      recordOutcome("envelopes", false, RejectionReason.SCHEMA_INVALID);
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
    //
    // We keep ONLY the canonical option label (`classifyAnswer`'s result), never
    // the raw `envelope.answer` we received (issue #137). The honest skill already
    // signs/sends just the canonical label (skill match_option backstop), but the
    // broker MUST NOT trust that: a tampered/injected client could smuggle free-
    // form prose ("yes — she runs prod from the Frankfurt box") that still
    // classifies to an option, or set no_signal=true and stuff text into `answer`
    // (which would skip this gate entirely). Persisting the classification instead
    // of the input means the answers table can never hold re-identifying micro-
    // data at rest, regardless of what any client sends. no_signal → empty string.
    const choice = envelope.no_signal
      ? ""
      : classifyAnswer(envelope.answer, question.options);
    if (choice === null) {
      return ack(false, RejectionReason.ANSWER_UNCLASSIFIED);
    }
    const storedAnswer = choice;

    // The envelope is stored under a per-question pseudonym, not the raw nullifier
    // (§1.4): voter_tag = HMAC(s_q, question_id | nullifier), where s_q is the
    // question's own secret, lazily minted here on first answer (ADR-098).
    // Deterministic, so a second answer from the same human lands on the same
    // row (an override, never a second vote); unlinkable, so the answers table
    // is no cross-question join key. Null only if the secret was already destroyed
    // (closed past grace) — fail closed rather than store an unkeyed envelope
    // (unreachable: step 6a already rejected closed/expired questions).
    const voterTag = await voterTagForInsert(
      envelope.question_id,
      verified.uniqueIdentifier,
      question.closesAt,
    );
    if (voterTag === null) return ack(false, RejectionReason.QUESTION_CLOSED);

    // Steps 7-8 in a transaction so aggregates + per-person counters can't drift
    // from envelopes.
    const row = {
      questionId: envelope.question_id,
      voterTag,
      // Canonical option label only — NEVER the raw received string (#137).
      answer: storedAnswer,
      noSignal: envelope.no_signal,
      disclosedPredicates: token.disclosed_predicates,
      agentSignature: envelope.agent_signature,
      delegationHashHex: verified.delegationHash,
    };
    let conflicted = false;
    await db.transaction(async (tx) => {
      let inserted = await q.insertEnvelope(tx, row);
      if (!inserted) {
        // Composite PK collision: this human already answered this question.
        // Re-answering overrides the earlier envelope in place (§1.12 — the
        // signal stays the user's to change while the question is open). The
        // total count is unchanged; only the signal/no-signal split can move.
        const prev = await q.overrideEnvelope(tx, row);
        if (prev !== null) {
          const signalDelta =
            (envelope.no_signal ? 0 : 1) - (prev.previousNoSignal ? 0 : 1);
          if (signalDelta !== 0) {
            await q.adjustAnswerCounters(tx, {
              uniqueIdentifier: verified.uniqueIdentifier,
              delta: 0,
              signalDelta,
            });
          }
        } else {
          // The earlier envelope was retracted between our INSERT attempt and
          // the override (concurrent revoke). overrideEnvelope left us holding
          // the question's advisory lock, so a retried INSERT is race-free.
          inserted = await q.insertEnvelope(tx, row);
          if (!inserted) {
            conflicted = true;
            return;
          }
        }
      }
      if (inserted) {
        await q.incrementAggregate(tx, {
          questionId: envelope.question_id,
          answer: storedAnswer,
          disclosedPredicates: token.disclosed_predicates,
          options: question.options,
          noSignal: envelope.no_signal,
        });
        // Per-person tally on the registration (the answers table no longer
        // holds a stable per-person key, §1.4 / §14.2). Keyed by the raw
        // nullifier.
        await q.adjustAnswerCounters(tx, {
          uniqueIdentifier: verified.uniqueIdentifier,
          delta: 1,
          signalDelta: envelope.no_signal ? 0 : 1,
        });
      }
      // Referral activation (REFERRALS.md §4): if this answer just pushed the
      // answerer over BOTH unlock thresholds and they have a pending referral,
      // flip it to active and credit their referrer's reputation. Idempotent and
      // usually a 0-row no-op, so it's cheap on the common (no-referral) path.
      await q.creditReferralOnActivation(tx, {
        refereeNullifier: verified.uniqueIdentifier,
        requiredTotal: settings.askerUnlockTotalAnswers,
        requiredSignal: settings.askerUnlockSignalAnswers,
        scorePerReferral: settings.repPerActiveReferral,
        boardThreshold: settings.repBoardThreshold,
      });
    });
    if (conflicted) return ack(false, RejectionReason.DUPLICATE);

    return ack(true);
  });
}
