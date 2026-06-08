// Per-question voter tag — the pseudonym stored in envelopes.unique_identifier
// instead of the raw Self nullifier (ARCHITECTURE_V0.md §1.4, ADR-098).
//
//   voter_tag = base64( HMAC-SHA256( s_q,
//                 "chorum-voter-tag-v1" | question_id | nullifier ) )
//
// where `s_q` is the question's OWN independently-random 32-byte linkage secret
// (questionSecret.ts), destroyed a grace period after the question closes.
//
// Properties:
//   - Deterministic per (question_id, nullifier) while the secret lives: the same
//     person answering the same question always produces the same tag, so the
//     composite PK (question_id, unique_identifier) still enforces one-answer-per-
//     human-per-question, and the broker can reproduce a person's tag to revoke a
//     single answer.
//   - Unlinkable across questions: two questions have two unrelated secrets AND
//     question_ids, so the same person's two answers carry unrelated tags — the
//     envelopes table is no cross-question join key for a person's history.
//   - Self-destructing: once s_q is destroyed (close + grace), NO one — not even
//     the broker — can re-derive that question's tags from a nullifier, so its
//     answers are orphaned from every identity permanently. This bounds the
//     re-identification liability to the live working set (#98 / ADR-098).
//
// Computed in the broker process only (the agent never sends unique_identifier;
// the broker derives the nullifier from the verified DelegationToken and tags it
// here). The secret lives only in the secrets instance, never in the shared DB.

import { createHmac } from "node:crypto";

import { ensureQuestionSecretKey, getQuestionSecretKeyIfLive } from "./questionSecret";

const DOMAIN = "chorum-voter-tag-v1";
// ASCII unit separator between fields, so (a|b) and (ab|"") can't collide.
const SEP = "\x1f";

// Pure HMAC over the question's raw key bytes.
function tagFromKey(key: Buffer, questionId: string, uniqueIdentifier: string): string {
  return createHmac("sha256", key)
    .update(DOMAIN)
    .update(SEP)
    .update(questionId)
    .update(SEP)
    .update(uniqueIdentifier)
    .digest("base64");
}

// Pure: derive a voter tag from an explicit base64 secret. Exposed for tests
// (determinism / unlinkability / secret-dependence golden vectors).
export function computeVoterTag(
  secretBase64: string,
  questionId: string,
  uniqueIdentifier: string,
): string {
  return tagFromKey(Buffer.from(secretBase64, "base64"), questionId, uniqueIdentifier);
}

// Answer path: ensure the question's secret exists (lazy mint on first answer),
// then derive the tag. Returns null only if the secret was already destroyed
// (question closed past grace) — the caller MUST reject rather than store an
// unkeyed envelope. `closesAt` is copied into the secret row for the reaper.
export async function voterTagForInsert(
  questionId: string,
  uniqueIdentifier: string,
  closesAt: Date,
): Promise<string | null> {
  const key = await ensureQuestionSecretKey(questionId, closesAt);
  if (key === null) return null;
  return tagFromKey(key, questionId, uniqueIdentifier);
}

// Revoke / invalidation path: derive the tag only if the question's secret is
// still live. Returns null once destroyed — the closed-question carve-out, since
// a closed question's aggregate is already published (ADR-098).
export async function voterTagIfLive(
  questionId: string,
  uniqueIdentifier: string,
): Promise<string | null> {
  const key = await getQuestionSecretKeyIfLive(questionId);
  if (key === null) return null;
  return tagFromKey(key, questionId, uniqueIdentifier);
}
