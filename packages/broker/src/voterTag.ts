// Per-question voter tag — the pseudonym stored in envelopes.unique_identifier
// instead of the raw Self nullifier (ARCHITECTURE_V0.md §1.4).
//
//   voter_tag = base64( HMAC-SHA256( linkage_secret,
//                 "hearme-voter-tag-v1" | question_id | nullifier ) )
//
// Properties:
//   - Deterministic per (question_id, nullifier): the same person answering the
//     same question always produces the same tag, so the composite PK
//     (question_id, unique_identifier) still enforces one-answer-per-human-per-
//     question, and the broker can reproduce a person's tag to revoke a single
//     answer.
//   - Unlinkable across questions: two different questions yield two unrelated
//     tags for the same person, so the envelopes table on its own is no longer a
//     cross-question join key for a person's answer history.
//   - Linkage requires the secret: the secret lives in broker config / SSM and is
//     never written to the shared DB. Re-linking the answers table to individuals
//     needs BOTH the secret AND the registrations nullifier list. v2 rotates the
//     secret per epoch; destroying an old epoch's secret makes that history
//     unlinkable even to the broker.
//
// Computed in the broker process only (the agent never sends unique_identifier;
// the broker derives the nullifier from the verified DelegationToken and tags it
// here). Keeping it out of SQL keeps the secret out of the database entirely.

import { createHmac } from "node:crypto";

import { getSettings } from "./config";

const DOMAIN = "hearme-voter-tag-v1";
// ASCII unit separator between fields, so (a|b) and (ab|"") can't collide.
const SEP = "\x1f";

// Pure: derive the per-question voter tag from an explicit base64 secret. Exposed
// for tests (determinism / unlinkability / secret-dependence golden vectors).
export function computeVoterTag(
  secretBase64: string,
  questionId: string,
  uniqueIdentifier: string,
): string {
  const key = Buffer.from(secretBase64, "base64");
  return createHmac("sha256", key)
    .update(DOMAIN)
    .update(SEP)
    .update(questionId)
    .update(SEP)
    .update(uniqueIdentifier)
    .digest("base64");
}

// Convenience bound to the running broker's configured linkage secret.
export function voterTagFor(questionId: string, uniqueIdentifier: string): string {
  return computeVoterTag(getSettings().voterTagSecret, questionId, uniqueIdentifier);
}
