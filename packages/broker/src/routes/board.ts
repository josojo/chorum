// Board / governance endpoints (REFERRALS.md §6).
//
//   POST /v1/board/claim  — an identity that has reached the 'board' reputation
//     tier presents a FRESH governance key and receives a broker-signed,
//     anonymous board credential bound to that key (never to its nullifier). The
//     broker records nullifier → gov_key (one live credential per human), but the
//     credential and the public roster expose only gov_key, so board actions are
//     unlinkable to the member's answers.
//   GET  /v1/board/roster — the public roster: live members as (gov_key, tier).
//
// Claim authenticates with the agent DelegationToken or a browser asker session
// (verify/identityAuth.ts), the same as the referral endpoints.

import type { FastifyInstance } from "fastify";

import type { Settings } from "../config";
import { getDb } from "../db";
import * as q from "../queries";
import {
  type BoardClaimResponse,
  type BoardRosterResponse,
  RejectionReason,
  boardClaimRequestSchema,
} from "../models";
import { issueBoardCredential } from "../verify/credential";
import { VerifyDelegationError } from "../verify/delegation";
import { authenticateIdentity } from "../verify/identityAuth";

const DAY_MS = 24 * 60 * 60 * 1000;

// A governance key must be a 32-byte Ed25519 public key, base64-encoded.
function isValidGovKey(govKey: string): boolean {
  try {
    return Buffer.from(govKey, "base64").length === 32;
  } catch {
    return false;
  }
}

export function registerBoardRoutes(
  app: FastifyInstance,
  opts: { settings: Settings },
): void {
  const { settings } = opts;
  const maybeReason = (reason: RejectionReason): string | null =>
    settings.exposeRejectionReasons ? reason : null;

  app.post("/v1/board/claim", async (req, reply) => {
    const parsed = boardClaimRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(422).send({ detail: parsed.error.issues });
    }
    const db = getDb();
    let identity;
    try {
      identity = await authenticateIdentity(db, parsed.data, { settings });
    } catch (exc) {
      if (exc instanceof VerifyDelegationError) {
        req.log.info(`board claim: auth failed: ${exc.message}`);
        const body: BoardClaimResponse = {
          authorized: false,
          eligible: false,
          tier: "none",
          score: 0,
          required_score: settings.repBoardThreshold,
          credential: null,
          reason: maybeReason(exc.reason),
        };
        return reply.code(401).send(body);
      }
      throw exc;
    }

    if (!isValidGovKey(parsed.data.gov_key)) {
      const body: BoardClaimResponse = {
        authorized: true,
        eligible: false,
        tier: "none",
        score: 0,
        required_score: settings.repBoardThreshold,
        credential: null,
        reason: maybeReason(RejectionReason.GOV_KEY_INVALID),
      };
      return reply.code(422).send(body);
    }

    const rep = await q.getReputation(db, identity.uniqueIdentifier);
    const score = rep?.score ?? 0;
    const required = settings.repBoardThreshold;
    if (score < required) {
      const body: BoardClaimResponse = {
        authorized: true,
        eligible: false,
        tier: rep?.tier ?? "none",
        score,
        required_score: required,
        credential: null,
        reason: maybeReason(RejectionReason.BOARD_NOT_ELIGIBLE),
      };
      return body;
    }

    // Eligible: record the claim (nullifier → gov_key, one live per human) and
    // mint the anonymous credential bound to gov_key.
    const now = new Date();
    const expiresAt = new Date(now.getTime() + settings.boardCredentialTtlDays * DAY_MS);
    await q.upsertBoardMember(db, {
      uniqueIdentifier: identity.uniqueIdentifier,
      govKey: parsed.data.gov_key,
      tier: "board",
      expiresAt,
    });
    const credential = issueBoardCredential({
      gov_key: parsed.data.gov_key,
      tier: "board",
      issued_at: now,
      expires_at: expiresAt,
      settings,
    });
    const body: BoardClaimResponse = {
      authorized: true,
      eligible: true,
      tier: "board",
      score,
      required_score: required,
      credential,
      reason: null,
    };
    return body;
  });

  app.get("/v1/board/roster", async () => {
    const members = await q.boardRoster(getDb());
    const body: BoardRosterResponse = {
      members: members.map((m) => ({ gov_key: m.govKey, tier: m.tier })),
    };
    return body;
  });
}
