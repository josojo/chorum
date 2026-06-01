// GET /v1/askers/:unique_identifier/eligibility — asker gating decision.
//
// The v0 unlock threshold of the answer-credit economy (ARCHITECTURE.md §15.3):
// may this identity open a new question yet? Only the broker can read envelopes
// (the privacy boundary, db/init/02-roles.sh), so the count and the decision
// live here. The web /ask flow will call this once asker auth presents a
// unique_identifier; until then it is a read-only diagnostic surface.
//
// Read-only and privacy-safe: it returns the asker's OWN counts and the public
// thresholds. It does not enumerate other identities or expose any answer text.

import type { FastifyInstance } from "fastify";

import { getDb } from "../db";
import * as q from "../queries";
import type { Settings } from "../config";
import {
  evaluateAskerEligibility,
  parseAdminIdentifiers,
} from "../askerGating";
import type { AskerEligibilityResponse } from "../models";

export function registerAskersRoutes(
  app: FastifyInstance,
  opts: { settings: Settings },
): void {
  const { settings } = opts;
  const admins = parseAdminIdentifiers(settings.askerAdminIdentifiers);

  app.get<{ Params: { uniqueIdentifier: string } }>(
    "/v1/askers/:uniqueIdentifier/eligibility",
    async (req) => {
      const uniqueIdentifier = req.params.uniqueIdentifier;
      const counts = await q.askerAnswerCounts(getDb(), uniqueIdentifier);
      const result = evaluateAskerEligibility({
        counts,
        thresholds: {
          requiredTotal: settings.askerUnlockTotalAnswers,
          requiredSignal: settings.askerUnlockSignalAnswers,
        },
        isAdmin: admins.has(uniqueIdentifier),
      });

      const body: AskerEligibilityResponse = {
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
      return body;
    },
  );
}
