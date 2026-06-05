// Referral endpoints — the bootstrap incentive surface (REFERRALS.md §3).
//
//   POST /v1/referrals/create — a registered identity mints a single-use code to
//     share. The broker stores only sha256(code) → referrer nullifier and returns
//     the cleartext exactly once. The nullifier is NEVER published; the code is an
//     identity-free bearer token only the broker can resolve back.
//   POST /v1/referrals/stats  — that identity's referral + reputation dashboard.
//
// Both authenticate with EITHER the agent DelegationToken or a browser asker
// session (verify/identityAuth.ts), so the "invite a friend" button works from
// the web app and the agent alike.

import type { FastifyInstance } from "fastify";

import type { Settings } from "../config";
import { getDb } from "../db";
import * as q from "../queries";
import {
  type ReferralCreateResponse,
  type ReferralStatsResponse,
  RejectionReason,
  referralCreateRequestSchema,
  referralStatsRequestSchema,
} from "../models";
import { iso } from "../verify/credential";
import { VerifyDelegationError } from "../verify/delegation";
import { authenticateIdentity } from "../verify/identityAuth";
import { generateReferralCode, hashReferralCode } from "../verify/referralCode";

const DAY_MS = 24 * 60 * 60 * 1000;

export function registerReferralsRoutes(
  app: FastifyInstance,
  opts: { settings: Settings },
): void {
  const { settings } = opts;
  const maybeReason = (reason: RejectionReason): string | null =>
    settings.exposeRejectionReasons ? reason : null;

  app.post("/v1/referrals/create", async (req, reply) => {
    const parsed = referralCreateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(422).send({ detail: parsed.error.issues });
    }
    const db = getDb();
    let identity;
    try {
      identity = await authenticateIdentity(db, parsed.data, { settings });
    } catch (exc) {
      if (exc instanceof VerifyDelegationError) {
        req.log.info(`referral create: auth failed: ${exc.message}`);
        return reply.code(401).send({ error: maybeReason(exc.reason) });
      }
      throw exc;
    }

    // Bound how many live codes one referrer can hold at once.
    const live = await q.countLiveReferralCodes(db, identity.uniqueIdentifier);
    if (live >= settings.referralMaxActiveCodes) {
      return reply
        .code(429)
        .send({ error: maybeReason(RejectionReason.REFERRAL_LIMIT_REACHED) });
    }

    const code = generateReferralCode();
    const expiresAt = new Date(Date.now() + settings.referralCodeTtlDays * DAY_MS);
    await q.createReferralCode(db, {
      codeHash: hashReferralCode(code),
      referrerNullifier: identity.uniqueIdentifier,
      maxUses: 1,
      expiresAt,
    });
    const body: ReferralCreateResponse = { code, expires_at: iso(expiresAt) };
    return body;
  });

  app.post("/v1/referrals/stats", async (req, reply) => {
    const parsed = referralStatsRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(422).send({ detail: parsed.error.issues });
    }
    const db = getDb();
    let identity;
    try {
      identity = await authenticateIdentity(db, parsed.data, { settings });
    } catch (exc) {
      if (exc instanceof VerifyDelegationError) {
        req.log.info(`referral stats: auth failed: ${exc.message}`);
        return reply.code(401).send({ error: maybeReason(exc.reason) });
      }
      throw exc;
    }

    const stats = await q.referralStatsFor(db, identity.uniqueIdentifier);
    const body: ReferralStatsResponse = {
      unique_identifier: identity.uniqueIdentifier,
      codes_minted: stats.codesMinted,
      code_redemptions: stats.codeRedemptions,
      pending_referrals: stats.pendingReferrals,
      active_referrals: stats.activeReferrals,
      score: stats.score,
      tier: stats.tier,
    };
    return body;
  });
}
