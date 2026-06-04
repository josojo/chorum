// POST /v1/register — verify-once enrollment (ARCHITECTURE_V0.md §5/§8).
//
//   1. Parse the EnrollmentBundle (zod, strict).
//   2. Verify every Self proof via the self-bridge + derive bucketed predicates.
//   3. Atomically bind nullifier -> agent_key in the registrations registry.
//   4. Mint and return the broker-signed DelegationToken.

import type { FastifyInstance } from "fastify";

import { getSettings } from "../config";
import { getDb } from "../db";
import { recordOutcome } from "../observability/metrics";
import * as q from "../queries";
import {
  type DelegationToken,
  type RegisterAck,
  RejectionReason,
  enrollmentBundleSchema,
} from "../models";
import type { VerifySelfProof } from "../verify/bridgeClient";
import { issueDelegationToken } from "../verify/credential";
import { VerifyEnrollmentError, verifyEnrollment } from "../verify/selfIdentity";

// DelegationToken TTL (independent of Self's ±1 day proof-freshness window —
// the proof is verified once, here, then never replayed).
const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function ack(
  accepted: boolean,
  opts: { token?: DelegationToken; reason?: RejectionReason } = {},
): RegisterAck {
  // Record the TRUE outcome/reason before the expose gate — metrics see what the
  // caller doesn't when EXPOSE_REJECTION_REASONS=0.
  recordOutcome("register", accepted, opts.reason);
  const settings = getSettings();
  if (!accepted && !settings.exposeRejectionReasons) {
    return { accepted: false, delegation_token: null, reason: null };
  }
  return { accepted, delegation_token: opts.token ?? null, reason: opts.reason ?? null };
}

export function registerRegisterRoutes(
  app: FastifyInstance,
  deps: { verifyProof?: VerifySelfProof } = {},
): void {
  app.post("/v1/register", async (req, reply) => {
    const parsed = enrollmentBundleSchema.safeParse(req.body);
    if (!parsed.success) {
      recordOutcome("register", false, RejectionReason.SCHEMA_INVALID);
      return reply.code(422).send({ detail: parsed.error.issues });
    }

    // Step 2: verify the Self proofs (bridge) + derive predicates.
    let verified;
    try {
      verified = await verifyEnrollment(parsed.data, { verifyProof: deps.verifyProof });
    } catch (exc) {
      if (exc instanceof VerifyEnrollmentError) {
        req.log.info(`registration verify failed: ${exc.message}`);
        return ack(false, { reason: exc.reason });
      }
      throw exc;
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS);

    const db = getDb();
    if (await q.isSelfNullifierInvalidated(db, verified.uniqueIdentifier)) {
      return ack(false, { reason: RejectionReason.IDENTITY_REVOKED });
    }

    // Step 3: atomic Sybil bind.
    const status = await q.upsertRegistration(db, {
      uniqueIdentifier: verified.uniqueIdentifier,
      agentKey: verified.agentKey,
      disclosedPredicates: verified.disclosedPredicates,
      issuedAt: now,
      expiresAt,
    });
    if (status === null) {
      return ack(false, { reason: RejectionReason.IDENTITY_ALREADY_BOUND });
    }

    // Step 4: mint the broker-signed session credential.
    const token = issueDelegationToken({
      unique_identifier: verified.uniqueIdentifier,
      disclosed_predicates: verified.disclosedPredicates,
      agent_key: verified.agentKey,
      issued_at: now,
      expires_at: expiresAt,
    });
    return ack(true, { token });
  });
}
