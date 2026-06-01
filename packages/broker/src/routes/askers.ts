// Asker auth + gating — the v0 answer-credit economy surface (ARCHITECTURE.md
// §15.3). Two ways to prove a registered identity, both ending in the SAME gate
// (does this identity clear the unlock threshold?):
//
//   1. POST /v1/askers/eligibility — replay a broker-signed DelegationToken (the
//      agent's credential). Token = possession of a live, non-revoked binding.
//
//   2. "Sign in with Self" (the browser path):
//        POST /v1/askers/login/start          — mint a Self login QR (via the
//                                                bridge the broker controls).
//        GET  /v1/askers/login/:id/status     — poll; on a verified scan, derive
//                                                the nullifier and mint a session.
//        POST /v1/askers/session/verify       — replay that session on submit.
//      The nullifier is deterministic per scope, so a fresh scan re-derives the
//      SAME identity the agent registered under — and the score keys on the
//      nullifier alone. The browser only ever holds a requestId or a broker-
//      signed session; it can never assert a raw identity.
//
// Only the broker can read envelopes + registrations (db/init/02-roles.sh), so
// both the auth and the count live here. The web /ask flow gates on this.

import type { FastifyInstance } from "fastify";
import nacl from "tweetnacl";

import { getDb } from "../db";
import type { Settings } from "../config";
import {
  evaluateAskerEligibility,
  parseAdminIdentifiers,
} from "../askerGating";
import {
  type AskerEligibilityResponse,
  type AskerLoginStatusResponse,
  RejectionReason,
  askerEligibilityRequestSchema,
  askerLoginStartRequestSchema,
  askerSessionVerifyRequestSchema,
} from "../models";
import {
  BridgeError,
  type CreateSelfRequest,
  type GetSelfRequest,
  createSelfRequest as realCreateSelfRequest,
  getSelfRequest as realGetSelfRequest,
} from "../verify/bridgeClient";
import {
  ASKER_SESSION_TTL_MS,
  issueAskerSession,
  verifyAskerSession,
} from "../verify/askerSession";
import { VerifyDelegationError, verifyDelegation } from "../verify/delegation";
import * as q from "../queries";

export function registerAskersRoutes(
  app: FastifyInstance,
  opts: {
    settings: Settings;
    // Injectable bridge clients (tests drive login without a real bridge).
    createSelfRequest?: CreateSelfRequest;
    getSelfRequest?: GetSelfRequest;
  },
): void {
  const { settings } = opts;
  const createSelfRequest = opts.createSelfRequest ?? realCreateSelfRequest;
  const getSelfRequest = opts.getSelfRequest ?? realGetSelfRequest;
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

  // The gate decision for an already-authenticated identity. Shared by every
  // auth path so the answer-credit rule is computed in exactly one place.
  async function eligibilityFor(
    uniqueIdentifier: string,
  ): Promise<AskerEligibilityResponse> {
    const db = getDb();
    const counts = await q.askerAnswerCounts(db, uniqueIdentifier);
    const result = evaluateAskerEligibility({
      counts,
      thresholds: { requiredTotal, requiredSignal },
      isAdmin: admins.has(uniqueIdentifier),
    });
    return {
      authorized: true,
      auth_reason: null,
      unique_identifier: uniqueIdentifier,
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
  }

  function maybeReason(reason: RejectionReason): string | null {
    return settings.exposeRejectionReasons ? reason : null;
  }

  // ----- 1. token replay ---------------------------------------------------

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

    // Authenticated. Now the gate.
    return eligibilityFor(verified.uniqueIdentifier);
  });

  // ----- 2. Sign in with Self ----------------------------------------------

  // Start a login: mint a Self request via the bridge and hand the browser the
  // QR urls. The agentKey here is an ephemeral throwaway — the nullifier the
  // scan yields is independent of it, and we never persist it.
  app.post("/v1/askers/login/start", async (req, reply) => {
    const parsed = askerLoginStartRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(422).send({ detail: parsed.error.issues });
    }
    const ephemeralAgentKey = Buffer.from(
      nacl.sign.keyPair().publicKey,
    ).toString("base64");
    try {
      const { requestId, urls } = await createSelfRequest({
        bridgeUrl: settings.selfBridgeUrl,
        agentKey: ephemeralAgentKey,
        profile: parsed.data.profile ?? "minimal",
        timeout: settings.selfVerifyTimeoutSeconds,
      });
      return { request_id: requestId, qr_urls: urls };
    } catch (exc) {
      if (exc instanceof BridgeError) {
        req.log.warn(`asker login start: bridge error: ${exc.message}`);
        return reply
          .code(502)
          .send({ error: maybeReason(RejectionReason.SELF_BRIDGE_ERROR) });
      }
      throw exc;
    }
  });

  // Poll a login. Once the bridge reports a verified proof, derive the
  // nullifier, run the gate, and mint a short-lived session to replay on submit.
  app.get<{ Params: { requestId: string } }>(
    "/v1/askers/login/:requestId/status",
    async (req, reply) => {
      const requestId = req.params.requestId;
      let status;
      try {
        status = await getSelfRequest({
          bridgeUrl: settings.selfBridgeUrl,
          requestId,
          timeout: settings.selfVerifyTimeoutSeconds,
        });
      } catch (exc) {
        if (exc instanceof BridgeError) {
          req.log.warn(`asker login status: bridge error: ${exc.message}`);
          return reply
            .code(502)
            .send({ error: maybeReason(RejectionReason.SELF_BRIDGE_ERROR) });
        }
        throw exc;
      }

      const pending: AskerLoginStatusResponse = {
        status: "pending",
        reason: null,
        eligibility: null,
        asker_session: null,
      };
      const failed = (reason: RejectionReason): AskerLoginStatusResponse => ({
        status: "failed",
        reason: maybeReason(reason),
        eligibility: null,
        asker_session: null,
      });

      if (!status.found) return reply.code(404).send({ error: "unknown requestId" });
      if (status.status !== "complete") return pending;

      if (!status.verified || !status.uniqueIdentifier) {
        return failed(RejectionReason.SELF_PROOF_INVALID);
      }
      // Sybil hardening parity with registration (§5).
      if (settings.requireRegistryConfirmation && !status.registryConfirmed) {
        return failed(RejectionReason.SELF_REGISTRY_UNCONFIRMED);
      }
      if (await q.isSelfNullifierInvalidated(getDb(), status.uniqueIdentifier)) {
        return failed(RejectionReason.IDENTITY_REVOKED);
      }

      const now = new Date();
      const session = issueAskerSession({
        unique_identifier: status.uniqueIdentifier,
        issued_at: now,
        expires_at: new Date(now.getTime() + ASKER_SESSION_TTL_MS),
      });
      const body: AskerLoginStatusResponse = {
        status: "complete",
        reason: null,
        eligibility: await eligibilityFor(status.uniqueIdentifier),
        asker_session: session,
      };
      return body;
    },
  );

  // Re-verify a session on question submit. Mirrors the token path's gate, but
  // authenticates by the broker's signature on the session (proof-of-Self at
  // login), not by a registration/agent_key binding.
  app.post("/v1/askers/session/verify", async (req, reply) => {
    const parsed = askerSessionVerifyRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(422).send({ detail: parsed.error.issues });
    }
    let identity;
    try {
      identity = verifyAskerSession(parsed.data.asker_session);
    } catch (exc) {
      if (exc instanceof VerifyDelegationError) {
        req.log.info(`asker auth: session verify failed: ${exc.message}`);
        return unauthorized(exc.reason);
      }
      throw exc;
    }
    if (await q.isSelfNullifierInvalidated(getDb(), identity.uniqueIdentifier)) {
      return unauthorized(RejectionReason.IDENTITY_REVOKED);
    }
    return eligibilityFor(identity.uniqueIdentifier);
  });
}
