// All SQL the broker runs. Parameterized via Drizzle's `sql` template (no string
// interpolation of values). Mirrors db/queries.py one-for-one — the DB shape is
// governed by the reused schema (packages/web/src/db/schema.ts), wired into the
// Drizzle instance in db.ts and applied via the migrations generated from it.
//
// We use raw `sql` throughout (rather than the typed query builder) because the
// broker and web resolve separate physical drizzle-orm copies in local dev, which
// makes the builder's table objects type-incompatible across the package boundary
// even though they are identical at runtime. Raw `sql` depends only on the
// broker's own drizzle-orm and is the exact shape of the original Python queries.

import { sql, type ExtractTablesWithRelations } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";

import type { Db } from "./db";
import type * as schema from "./schema";
import { classifyAnswer, computeByPredicate, computeNoSignal } from "./aggregates";
import { voterTagFor } from "./voterTag";

export type Tx = PgTransaction<
  PostgresJsQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;
export type Executor = Db | Tx;

// postgres-js returns jsonb already parsed; keep a defensive normalizer.
function normalizeOptions(raw: unknown): string[] {
  if (raw == null) return ["yes", "no"];
  let v = raw;
  if (typeof v === "string") v = JSON.parse(v);
  if (Array.isArray(v)) return v.map((x) => String(x));
  return ["yes", "no"];
}

type Rows<T> = T[];

// ----- questions ---------------------------------------------------------

export interface OpenQuestion {
  id: string;
  text: string;
  topic: string | null;
  options: string[];
  createdAt: Date;
  closesAt: Date;
  nonce: string;
}

// Open + not-yet-closed questions, optionally filtered by created_at >= since.
//
// `topic IS NOT NULL` is load-bearing, not cosmetic: the classifier service
// assigns topic asynchronously after insert (create-question.ts inserts with a
// NULL topic). Until it has run, a question must NOT be visible to polling
// agents — otherwise a sensitive question, fetched in the pre-classification
// window, reaches the skill with an empty topic, where auto_answer matches
// before any topic check and a responder's topic_blocklist can't fire (§1.1
// "consent is the product"; skill policy.rs). Filtering unclassified rows out
// here is the gate create-question.ts's comment promises.
export async function listOpenQuestions(db: Db, since: Date | null): Promise<OpenQuestion[]> {
  const query =
    since === null
      ? sql`
          SELECT id, text, topic, options, created_at, closes_at, nonce
          FROM questions
          WHERE status = 'open' AND closes_at > now() AND topic IS NOT NULL
          ORDER BY created_at ASC`
      : sql`
          SELECT id, text, topic, options, created_at, closes_at, nonce
          FROM questions
          WHERE status = 'open' AND closes_at > now() AND topic IS NOT NULL AND created_at >= ${since.toISOString()}::timestamptz
          ORDER BY created_at ASC`;
  const rows = (await db.execute(query)) as unknown as Rows<{
    id: string;
    text: string;
    topic: string | null;
    options: unknown;
    created_at: string | Date;
    closes_at: string | Date;
    nonce: string;
  }>;
  // drizzle's raw execute returns timestamptz as strings; coerce to Date.
  return rows.map((r) => ({
    id: r.id,
    text: r.text,
    topic: r.topic,
    options: normalizeOptions(r.options),
    createdAt: new Date(r.created_at),
    closesAt: new Date(r.closes_at),
    nonce: r.nonce,
  }));
}

export interface QuestionForVerify {
  id: string;
  status: string;
  closesAt: Date;
  nonce: string;
  scope: string;
  country: string | null;
  continent: string | null;
  options: string[];
}

export async function getQuestionForVerify(
  db: Db,
  questionId: string,
): Promise<QuestionForVerify | null> {
  const rows = (await db.execute(sql`
    SELECT id, status, closes_at, nonce, scope, country, continent, options
    FROM questions
    WHERE id = ${questionId}
  `)) as unknown as Rows<{
    id: string;
    status: string;
    closes_at: string | Date;
    nonce: string;
    scope: string;
    country: string | null;
    continent: string | null;
    options: unknown;
  }>;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    closesAt: new Date(row.closes_at),
    nonce: row.nonce,
    scope: row.scope,
    country: row.country,
    continent: row.continent,
    options: normalizeOptions(row.options),
  };
}

// ----- revocations -------------------------------------------------------

export async function isRevoked(db: Executor, delegationHashHex: string): Promise<boolean> {
  const rows = (await db.execute(sql`
    SELECT 1 AS one FROM revocations WHERE delegation_hash = ${delegationHashHex} LIMIT 1
  `)) as unknown as Rows<unknown>;
  return rows.length > 0;
}

// ----- registrations (nullifier registry) --------------------------------

// Atomically bind unique_identifier (nullifier) to agent_key.
//   "created"   — first registration of this nullifier.
//   "refreshed" — re-registration with the SAME agent_key (or after revocation).
//   null        — nullifier already bound to a DIFFERENT, non-revoked agent_key.
export async function upsertRegistration(
  db: Executor,
  args: {
    uniqueIdentifier: string;
    agentKey: string;
    disclosedPredicates: Record<string, string>;
    issuedAt: Date;
    expiresAt: Date;
  },
): Promise<"created" | "refreshed" | null> {
  const rows = (await db.execute(sql`
    INSERT INTO registrations (
      unique_identifier, agent_key, disclosed_predicates,
      issued_at, expires_at, revoked_at
    ) VALUES (
      ${args.uniqueIdentifier}, ${args.agentKey},
      ${JSON.stringify(args.disclosedPredicates)}::jsonb,
      ${args.issuedAt.toISOString()}::timestamptz, ${args.expiresAt.toISOString()}::timestamptz, NULL
    )
    ON CONFLICT (unique_identifier) DO UPDATE
    SET agent_key = EXCLUDED.agent_key,
        disclosed_predicates = EXCLUDED.disclosed_predicates,
        issued_at = EXCLUDED.issued_at,
        expires_at = EXCLUDED.expires_at,
        revoked_at = NULL
    WHERE registrations.agent_key = EXCLUDED.agent_key
       OR registrations.revoked_at IS NOT NULL
    RETURNING (xmax = 0) AS inserted
  `)) as unknown as Rows<{ inserted: boolean }>;
  const row = rows[0];
  if (!row) return null;
  return row.inserted ? "created" : "refreshed";
}

export interface Registration {
  uniqueIdentifier: string;
  agentKey: string;
  disclosedPredicates: Record<string, string>;
  issuedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

export async function getRegistration(
  db: Executor,
  uniqueIdentifier: string,
): Promise<Registration | null> {
  const rows = (await db.execute(sql`
    SELECT unique_identifier, agent_key, disclosed_predicates,
           issued_at, expires_at, revoked_at
    FROM registrations
    WHERE unique_identifier = ${uniqueIdentifier}
  `)) as unknown as Rows<{
    unique_identifier: string;
    agent_key: string;
    disclosed_predicates: unknown;
    issued_at: string | Date;
    expires_at: string | Date;
    revoked_at: string | Date | null;
  }>;
  const row = rows[0];
  if (!row) return null;
  return {
    uniqueIdentifier: row.unique_identifier,
    agentKey: row.agent_key,
    disclosedPredicates: row.disclosed_predicates as Record<string, string>,
    issuedAt: new Date(row.issued_at),
    expiresAt: new Date(row.expires_at),
    revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at),
  };
}

export interface InvalidationResult {
  recorded: boolean;
  registrationRevoked: boolean;
  deletedEnvelopes: number;
  affectedQuestions: number;
}

// Apply a Self on-chain invalidation for one Hearme nullifier: record it, revoke
// the registration, delete its accepted envelopes, and recompute every affected
// aggregate — all in one transaction.
export async function invalidateRegistrationAndVotes(
  db: Db,
  args: {
    uniqueIdentifier: string;
    source: string;
    chainId: string | null;
    blockNumber: number;
    logIndex: number;
    txHash: string;
  },
): Promise<InvalidationResult> {
  return db.transaction(async (tx) => {
    const insertedRows = (await tx.execute(sql`
      INSERT INTO self_nullifier_invalidations (
        unique_identifier, source, chain_id, block_number, log_index, tx_hash
      ) VALUES (
        ${args.uniqueIdentifier}, ${args.source}, ${args.chainId},
        ${args.blockNumber}, ${args.logIndex}, ${args.txHash}
      )
      ON CONFLICT (unique_identifier) DO NOTHING
      RETURNING 1 AS recorded
    `)) as unknown as Rows<unknown>;

    // Revoke the binding AND zero its answer counters — the envelopes that backed
    // them are about to be deleted, so the §14.2 tallies must reset (a later
    // re-registration with the same key resumes from 0).
    const revokedRows = (await tx.execute(sql`
      UPDATE registrations
      SET revoked_at = COALESCE(revoked_at, now()),
          answer_count = 0,
          signal_count = 0
      WHERE unique_identifier = ${args.uniqueIdentifier}
      RETURNING 1 AS revoked
    `)) as unknown as Rows<unknown>;

    // This identity's envelopes are stored under per-question voter tags (§1.4),
    // not the raw nullifier — so we can't match them with a single equality.
    // Recompute the tag for every question that has any envelope and delete the
    // matches (the linkage secret lives only in the broker process). Question
    // count bounds the work; invalidation is rare.
    const answered = (await tx.execute(sql`
      SELECT DISTINCT question_id FROM envelopes
    `)) as unknown as Rows<{ question_id: string }>;
    const tags = answered.map((r) => voterTagFor(r.question_id, args.uniqueIdentifier));
    const affectedRows =
      tags.length === 0
        ? []
        : ((await tx.execute(sql`
            DELETE FROM envelopes
            WHERE unique_identifier = ANY(${tags}::text[])
            RETURNING question_id
          `)) as unknown as Rows<{ question_id: string }>);
    const affectedQuestionIds = [...new Set(affectedRows.map((r) => r.question_id))].sort();

    for (const questionId of affectedQuestionIds) {
      await recomputeAggregate(tx, questionId);
    }

    return {
      recorded: insertedRows.length > 0,
      registrationRevoked: revokedRows.length > 0,
      deletedEnvelopes: affectedRows.length,
      affectedQuestions: affectedQuestionIds.length,
    };
  });
}

// Find a registration by any normalized Self nullifier form and invalidate it.
// The invalidation is recorded for every candidate so a chain event that arrives
// before a matching registration still blocks a stale proof from registering.
export async function invalidateFirstMatchingRegistrationAndVotes(
  db: Db,
  args: {
    candidates: string[];
    source: string;
    chainId: string | null;
    blockNumber: number;
    logIndex: number;
    txHash: string;
  },
): Promise<InvalidationResult | null> {
  if (args.candidates.length === 0) return null;
  const found = (await db.execute(sql`
    SELECT unique_identifier
    FROM registrations
    WHERE unique_identifier = ANY(${args.candidates}::text[])
    ORDER BY unique_identifier
    LIMIT 1
  `)) as unknown as Rows<{ unique_identifier: string }>;
  const uniqueIdentifier = found[0]?.unique_identifier;
  if (uniqueIdentifier === undefined) {
    for (const candidate of args.candidates) {
      await db.execute(sql`
        INSERT INTO self_nullifier_invalidations (
          unique_identifier, source, chain_id, block_number, log_index, tx_hash
        ) VALUES (
          ${candidate}, ${args.source}, ${args.chainId},
          ${args.blockNumber}, ${args.logIndex}, ${args.txHash}
        )
        ON CONFLICT (unique_identifier) DO NOTHING
      `);
    }
    return { recorded: true, registrationRevoked: false, deletedEnvelopes: 0, affectedQuestions: 0 };
  }
  return invalidateRegistrationAndVotes(db, { ...args, uniqueIdentifier });
}

export async function isSelfNullifierInvalidated(
  db: Executor,
  uniqueIdentifier: string,
): Promise<boolean> {
  const rows = (await db.execute(sql`
    SELECT 1 AS one
    FROM self_nullifier_invalidations
    WHERE unique_identifier = ${uniqueIdentifier}
  `)) as unknown as Rows<unknown>;
  return rows.length > 0;
}

export async function getSelfChainCursor(db: Db, name: string): Promise<number | null> {
  const rows = (await db.execute(sql`
    SELECT last_block FROM self_chain_cursors WHERE name = ${name}
  `)) as unknown as Rows<{ last_block: string | number }>;
  const row = rows[0];
  return row ? Number(row.last_block) : null;
}

export async function upsertSelfChainCursor(
  db: Db,
  args: { name: string; lastBlock: number },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO self_chain_cursors (name, last_block, updated_at)
    VALUES (${args.name}, ${args.lastBlock}, now())
    ON CONFLICT (name) DO UPDATE
    SET last_block = EXCLUDED.last_block, updated_at = now()
  `);
}

// ----- envelopes ---------------------------------------------------------

// INSERT one envelope; return false if PK collision (duplicate). The composite PK
// (question_id, unique_identifier) is the hard Sybil-resistance gate. The
// `voterTag` written into unique_identifier is the per-question pseudonym
// (voterTag.ts) — NOT the raw nullifier — so the table is unlinkable across
// questions; callers MUST pass the tag, never the nullifier.
export async function insertEnvelope(
  db: Executor,
  args: {
    questionId: string;
    voterTag: string;
    answer: string;
    noSignal: boolean;
    disclosedPredicates: Record<string, string>;
    agentSignature: string;
    delegationHashHex: string;
  },
): Promise<boolean> {
  const rows = (await db.execute(sql`
    INSERT INTO envelopes (
      question_id, unique_identifier, answer, no_signal, disclosed_predicates,
      agent_signature, delegation_hash
    ) VALUES (
      ${args.questionId}, ${args.voterTag}, ${args.answer}, ${args.noSignal},
      ${JSON.stringify(args.disclosedPredicates)}::jsonb,
      ${args.agentSignature}, ${args.delegationHashHex}
    )
    ON CONFLICT (question_id, unique_identifier) DO NOTHING
    RETURNING 1 AS inserted
  `)) as unknown as Rows<unknown>;
  return rows.length === 1;
}

// Move an identity's answer tallies on the registration as envelopes are accepted
// or removed. `delta` is +1 on insert, -1 on revoke; `signalDelta` likewise for
// the opinion-bearing subset. Counts can never go negative (GREATEST). The
// registration row is keyed by the raw nullifier (the broker has it from the
// verified token); this is where per-person totals live now that the envelopes
// table carries only per-question pseudonyms (§1.4, §14.2). MUST run in the same
// transaction as the matching envelope INSERT/DELETE.
export async function adjustAnswerCounters(
  db: Executor,
  args: { uniqueIdentifier: string; delta: number; signalDelta: number },
): Promise<void> {
  await db.execute(sql`
    UPDATE registrations
    SET answer_count = GREATEST(answer_count + ${args.delta}, 0),
        signal_count = GREATEST(signal_count + ${args.signalDelta}, 0)
    WHERE unique_identifier = ${args.uniqueIdentifier}
  `);
}

// ----- asker gating (answer-credit economy, §15) -------------------------

// One identity's submitted-answer tallies, split into total and signal-bearing.
// Backs the v0 asker unlock threshold (§14.2). Read from the registration's
// maintained counters rather than by scanning envelopes: the envelopes table no
// longer carries a stable per-person key (it stores per-question voter tags,
// §1.4), so a person's total cannot be derived from answers — it is accumulated
// on the registration as envelopes are inserted/revoked/invalidated.
//
// "Signal-bearing" is `no_signal = false` (§1.14): the agent had relevant memory
// and expressed an opinion, rather than skipping generation. The §15.4 anti-
// farming clause counts on this split so grinding cheap no-signal envelopes
// can't buy ask-rights. Returns {0,0} for an unknown identity.
export async function askerAnswerCounts(
  db: Executor,
  uniqueIdentifier: string,
): Promise<{ total: number; signal: number }> {
  const rows = (await db.execute(sql`
    SELECT answer_count AS total, signal_count AS signal
    FROM registrations
    WHERE unique_identifier = ${uniqueIdentifier}
  `)) as unknown as Rows<{ total: string | number; signal: string | number }>;
  const row = rows[0];
  return {
    total: row ? Number(row.total) : 0,
    signal: row ? Number(row.signal) : 0,
  };
}

// ----- asker admins (DB-backed bootstrap valve, §14.2) -------------------

// Is this identity a DB-listed admin? Admins bypass the unlock threshold
// (evaluateAskerEligibility). Read on every eligibility check, so it's a single
// indexed PK lookup. The broker also unions this with the static env allowlist
// (HEARME_BROKER_ASKER_ADMIN_IDENTIFIERS) — see routes/askers.ts.
export async function isAskerAdmin(
  db: Executor,
  uniqueIdentifier: string,
): Promise<boolean> {
  const rows = (await db.execute(sql`
    SELECT 1 AS one
    FROM asker_admins
    WHERE unique_identifier = ${uniqueIdentifier}
  `)) as unknown as Rows<unknown>;
  return rows.length > 0;
}

export interface AskerAdminRow {
  uniqueIdentifier: string;
  label: string | null;
  createdAt: Date;
  // Most recent display name this identity has asked under, if any. NULL for an
  // admin that has never opened a question (e.g. a freshly seeded one).
  displayName: string | null;
}

// List every DB admin, newest first, joined to the latest display name the
// identity has asked under (askers is web-written; the broker has SELECT on it,
// db/init/02-roles.sh). For the admin CLI's `list`.
export async function listAskerAdmins(db: Executor): Promise<AskerAdminRow[]> {
  const rows = (await db.execute(sql`
    SELECT a.unique_identifier, a.label, a.created_at,
           (SELECT k.display_name
              FROM askers k
             WHERE k.unique_identifier = a.unique_identifier
             ORDER BY k.created_at DESC
             LIMIT 1) AS display_name
    FROM asker_admins a
    ORDER BY a.created_at DESC
  `)) as unknown as Rows<{
    unique_identifier: string;
    label: string | null;
    created_at: string | Date;
    display_name: string | null;
  }>;
  return rows.map((r) => ({
    uniqueIdentifier: r.unique_identifier,
    label: r.label,
    createdAt: new Date(r.created_at),
    displayName: r.display_name,
  }));
}

// Promote an identity to admin (idempotent). Re-granting refreshes the label.
export async function grantAskerAdmin(
  db: Executor,
  args: { uniqueIdentifier: string; label: string | null },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO asker_admins (unique_identifier, label)
    VALUES (${args.uniqueIdentifier}, ${args.label})
    ON CONFLICT (unique_identifier) DO UPDATE
    SET label = EXCLUDED.label
  `);
}

// Demote an identity. Returns false if it wasn't an admin to begin with.
export async function revokeAskerAdmin(
  db: Executor,
  uniqueIdentifier: string,
): Promise<boolean> {
  const rows = (await db.execute(sql`
    DELETE FROM asker_admins
    WHERE unique_identifier = ${uniqueIdentifier}
    RETURNING 1 AS deleted
  `)) as unknown as Rows<unknown>;
  return rows.length === 1;
}

export interface AskerIdentityByName {
  uniqueIdentifier: string;
  displayName: string;
  createdAt: Date;
}

// Find verified identities that have asked under a given display name (case-
// insensitive, exact). Backs the CLI's `grant --name` lookup. Display names are
// NOT unique and only exist once an identity has asked, so this can return zero
// or many rows — the caller resolves the ambiguity.
export async function findAskerIdentitiesByName(
  db: Executor,
  displayName: string,
): Promise<AskerIdentityByName[]> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT ON (unique_identifier)
           unique_identifier, display_name, created_at
    FROM askers
    WHERE unique_identifier IS NOT NULL
      AND display_name ILIKE ${displayName}
    ORDER BY unique_identifier, created_at DESC
  `)) as unknown as Rows<{
    unique_identifier: string;
    display_name: string;
    created_at: string | Date;
  }>;
  return rows.map((r) => ({
    uniqueIdentifier: r.unique_identifier,
    displayName: r.display_name,
    createdAt: new Date(r.created_at),
  }));
}

// ----- aggregates --------------------------------------------------------

// Increment the aggregate row for one newly accepted envelope. The advisory
// xact lock serializes first-writer creation; FOR UPDATE then locks the single
// aggregate row. MUST run inside the same transaction as the envelope INSERT.
export async function incrementAggregate(
  db: Executor,
  args: {
    questionId: string;
    answer: string;
    disclosedPredicates: Record<string, string>;
    options?: readonly string[];
    // §1.14: a no-signal envelope counts toward total_answers and the dedicated
    // no_signal fields, but never toward the per-option by_predicate tallies.
    noSignal?: boolean;
  },
): Promise<void> {
  const options = args.options && args.options.length ? args.options : ["yes", "no"];
  const noSignal = args.noSignal === true;
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${String(args.questionId)}::text, 0))`,
  );
  const rows = (await db.execute(sql`
    SELECT total_answers, by_predicate, no_signal_total, no_signal_by_predicate
    FROM aggregates
    WHERE question_id = ${args.questionId}
    FOR UPDATE
  `)) as unknown as Rows<{
    total_answers: number;
    by_predicate: unknown;
    no_signal_total: number;
    no_signal_by_predicate: unknown;
  }>;
  const row = rows[0];

  const predEntries = Object.entries(args.disclosedPredicates ?? {});
  const empty: Record<string, number> = {};
  for (const o of options) empty[o] = 0;

  // Signal answers contribute to the per-option buckets; no_signal contributes
  // to the dedicated no_signal_by_predicate map instead.
  const delta: Record<string, Record<string, number>> = {};
  const nsDelta: Record<string, number> = {};
  if (noSignal) {
    for (const [k, v] of predEntries) nsDelta[`${k}:${v}`] = 1;
  } else {
    const choice = classifyAnswer(args.answer, options);
    for (const [k, v] of predEntries) {
      const key = `${k}:${v}`;
      const bucket = delta[key] ?? { ...empty };
      delta[key] = bucket;
      if (choice !== null) bucket[choice] = (bucket[choice] ?? 0) + 1;
    }
  }

  if (!row) {
    await db.execute(sql`
      INSERT INTO aggregates (
        question_id, total_answers, by_predicate,
        no_signal_total, no_signal_by_predicate, updated_at
      )
      VALUES (
        ${args.questionId}, 1, ${JSON.stringify(delta)}::jsonb,
        ${noSignal ? 1 : 0}, ${JSON.stringify(nsDelta)}::jsonb, now()
      )
    `);
    return;
  }

  const rawByPredicate = row.by_predicate;
  const parsed: Record<string, Record<string, number>> =
    typeof rawByPredicate === "string"
      ? JSON.parse(rawByPredicate)
      : ((rawByPredicate ?? {}) as Record<string, Record<string, number>>);
  const merged: Record<string, Record<string, number>> = { ...parsed };
  for (const [key, bucket] of Object.entries(delta)) {
    const current: Record<string, number> = { ...(merged[key] ?? {}) };
    const out: Record<string, number> = { ...empty };
    for (const [k, val] of Object.entries(current)) out[k] = Number(val);
    for (const [opt, n] of Object.entries(bucket)) out[opt] = (out[opt] ?? 0) + n;
    merged[key] = out;
  }

  const rawNs = row.no_signal_by_predicate;
  const parsedNs: Record<string, number> =
    typeof rawNs === "string"
      ? JSON.parse(rawNs)
      : ((rawNs ?? {}) as Record<string, number>);
  const mergedNs: Record<string, number> = { ...parsedNs };
  for (const [key, n] of Object.entries(nsDelta)) {
    mergedNs[key] = (Number(mergedNs[key]) || 0) + n;
  }

  await db.execute(sql`
    UPDATE aggregates
    SET total_answers = total_answers + 1,
        by_predicate = ${JSON.stringify(merged)}::jsonb,
        no_signal_total = no_signal_total + ${noSignal ? 1 : 0},
        no_signal_by_predicate = ${JSON.stringify(mergedNs)}::jsonb,
        updated_at = now()
    WHERE question_id = ${args.questionId}
  `);
}

// Rebuild one question's aggregate from its remaining envelopes (same path used
// by both the revoke override and the self-invalidation listener). Assumes the
// caller holds the advisory lock / is inside the deletion transaction.
async function recomputeAggregate(db: Executor, questionId: string): Promise<void> {
  const remaining = (await db.execute(sql`
    SELECT answer, no_signal, disclosed_predicates
    FROM envelopes
    WHERE question_id = ${questionId}
  `)) as unknown as Rows<{
    answer: string;
    no_signal: boolean;
    disclosed_predicates: unknown;
  }>;
  const total = remaining.length;
  if (total === 0) {
    await db.execute(sql`DELETE FROM aggregates WHERE question_id = ${questionId}`);
    return;
  }
  const optionsRows = (await db.execute(sql`
    SELECT options FROM questions WHERE id = ${questionId}
  `)) as unknown as Rows<{ options: unknown }>;
  const options = normalizeOptions(optionsRows[0]?.options);
  const envRows = remaining.map((r) => ({
    answer: r.answer,
    no_signal: r.no_signal === true,
    disclosed_predicates: r.disclosed_predicates as Record<string, string>,
  }));
  const byPredicate = computeByPredicate(
    // No-signal answers must not land in the per-option tallies (§1.14).
    envRows.filter((r) => !r.no_signal),
    options,
  );
  const noSignal = computeNoSignal(envRows);
  await db.execute(sql`
    INSERT INTO aggregates (
      question_id, total_answers, by_predicate,
      no_signal_total, no_signal_by_predicate, updated_at
    )
    VALUES (
      ${questionId}, ${total}, ${JSON.stringify(byPredicate)}::jsonb,
      ${noSignal.total}, ${JSON.stringify(noSignal.byPredicate)}::jsonb, now()
    )
    ON CONFLICT (question_id) DO UPDATE
    SET total_answers = EXCLUDED.total_answers,
        by_predicate = EXCLUDED.by_predicate,
        no_signal_total = EXCLUDED.no_signal_total,
        no_signal_by_predicate = EXCLUDED.no_signal_by_predicate,
        updated_at = now()
  `);
}

// ----- override (per-envelope revocation, §1.12) -------------------------

// Atomically delete one envelope and rebuild its question's aggregate. Returns
// true if an envelope was actually deleted, false if none matched (idempotent).
// `voterTag` is the per-question pseudonym stored in the row (the caller derives
// it from the question_id + nullifier, voterTag.ts); `uniqueIdentifier` is the
// raw nullifier, used only to roll back the registration's answer counters so
// the §14.2 gate stays exact after a retraction.
export async function deleteOneEnvelopeAndRecompute(
  db: Db,
  args: { questionId: string; voterTag: string; uniqueIdentifier: string },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${String(args.questionId)}::text, 0))`,
    );
    const deleted = (await tx.execute(sql`
      DELETE FROM envelopes
      WHERE question_id = ${args.questionId} AND unique_identifier = ${args.voterTag}
      RETURNING no_signal
    `)) as unknown as Rows<{ no_signal: boolean }>;
    if (deleted.length === 0) return false;
    const wasSignal = deleted[0].no_signal !== true;
    await adjustAnswerCounters(tx, {
      uniqueIdentifier: args.uniqueIdentifier,
      delta: -1,
      signalDelta: wasSignal ? -1 : 0,
    });
    await recomputeAggregate(tx, args.questionId);
    return true;
  });
}

// ----- platform stats ----------------------------------------------------

export interface PlatformStatsRow {
  registeredAgents: number;
  questions: number;
  totalAnswers: number;
  respondents: number;
  answeredQuestions: number;
}

// Privacy-safe site-wide counts. Only the broker role can read registrations and
// envelopes, so the broker is the single place these aggregates can be computed.
export async function platformStats(db: Db): Promise<PlatformStatsRow> {
  const rows = (await db.execute(sql`
    SELECT
      (SELECT COUNT(*) FROM registrations WHERE revoked_at IS NULL) AS registered_agents,
      (SELECT COUNT(*) FROM questions)                              AS questions,
      (SELECT COUNT(*) FROM envelopes)                              AS total_answers,
      -- Distinct people who have answered. Can't be COUNT(DISTINCT unique_identifier)
      -- on envelopes anymore: that column is now a per-question pseudonym (§1.4), so
      -- DISTINCT would count answer-instances, not people. The registration counter
      -- is the source of truth for per-person tallies.
      (SELECT COUNT(*) FROM registrations WHERE answer_count > 0)   AS respondents,
      (SELECT COUNT(DISTINCT question_id) FROM envelopes)           AS answered_questions
  `)) as unknown as Rows<Record<string, string | number>>;
  const row = rows[0];
  return {
    registeredAgents: Number(row.registered_agents),
    questions: Number(row.questions),
    totalAnswers: Number(row.total_answers),
    respondents: Number(row.respondents),
    answeredQuestions: Number(row.answered_questions),
  };
}
