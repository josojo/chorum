// DANGER — testing-only registration bypass.
//
// Mounted by server.ts ONLY when HEARME_BROKER_DEV_INSECURE_REGISTER=1. It mints
// a broker-signed DelegationToken for a SYNTHETIC identity without any Self proof
// or bridge verification, so the full answer→aggregate pipeline can be exercised
// end-to-end without a phone. This completely defeats proof-of-personhood; it
// must NEVER be enabled in production.

import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { getDb } from "../db";
import * as q from "../queries";
import { type RegisterAck, RejectionReason } from "../models";
import { issueDelegationToken } from "../verify/credential";
import { PredicateError, derivePredicates } from "../verify/predicates";

const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const devRegisterSchema = z
  .object({
    agent_key: z.string(),
    unique_identifier: z.string().nullable().optional(),
    nationality: z.string().default("US"),
    satisfied_thresholds: z.array(z.number().int()).default([18]),
  })
  .strict();

function isValid32ByteBase64(s: string): boolean {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) return false;
  return Buffer.from(s, "base64").length === 32;
}

export function registerDevRoutes(app: FastifyInstance): void {
  app.post("/v1/dev/register", async (req, reply) => {
    const parsed = devRegisterSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(422).send({ detail: parsed.error.issues });
    }
    const body = parsed.data;
    req.log.warn(
      `DEV INSECURE REGISTER used (no Self proof) nat=${body.nationality} thresholds=${body.satisfied_thresholds}`,
    );

    if (!isValid32ByteBase64(body.agent_key)) {
      const ack: RegisterAck = {
        accepted: false,
        delegation_token: null,
        reason: RejectionReason.ENROLLMENT_MALFORMED,
      };
      return ack;
    }

    let predicates: Record<string, string>;
    try {
      predicates = derivePredicates({
        nationality: body.nationality,
        satisfiedThresholds: body.satisfied_thresholds,
      });
    } catch (exc) {
      if (exc instanceof PredicateError) {
        const ack: RegisterAck = {
          accepted: false,
          delegation_token: null,
          reason: RejectionReason.PREDICATE_DERIVATION_FAILED,
        };
        return ack;
      }
      throw exc;
    }

    const nullifier = body.unique_identifier || randomBytes(32).toString("base64");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS);

    const status = await q.upsertRegistration(getDb(), {
      uniqueIdentifier: nullifier,
      agentKey: body.agent_key,
      disclosedPredicates: predicates,
      issuedAt: now,
      expiresAt,
    });
    if (status === null) {
      const ack: RegisterAck = {
        accepted: false,
        delegation_token: null,
        reason: RejectionReason.IDENTITY_ALREADY_BOUND,
      };
      return ack;
    }

    const token = issueDelegationToken({
      unique_identifier: nullifier,
      disclosed_predicates: predicates,
      agent_key: body.agent_key,
      issued_at: now,
      expires_at: expiresAt,
    });
    const ack: RegisterAck = { accepted: true, delegation_token: token, reason: null };
    return ack;
  });
}
