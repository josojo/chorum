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
import { classifyAnswer, computeByPredicate } from "./aggregates";

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
export async function listOpenQuestions(db: Db, since: Date | null): Promise<OpenQuestion[]> {
  const query =
    since === null
      ? sql`
          SELECT id, text, topic, options, created_at, closes_at, nonce
          FROM questions
          WHERE status = 'open' AND closes_at > now()
          ORDER BY created_at ASC`
      : sql`
          SELECT id, text, topic, options, created_at, closes_at, nonce
          FROM questions
          WHERE status = 'open' AND closes_at > now() AND created_at >= ${since.toISOString()}::timestamptz
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

    const revokedRows = (await tx.execute(sql`
      UPDATE registrations
      SET revoked_at = COALESCE(revoked_at, now())
      WHERE unique_identifier = ${args.uniqueIdentifier}
      RETURNING 1 AS revoked
    `)) as unknown as Rows<unknown>;

    const affectedRows = (await tx.execute(sql`
      DELETE FROM envelopes
      WHERE unique_identifier = ${args.uniqueIdentifier}
      RETURNING question_id
    `)) as unknown as Rows<{ question_id: string }>;
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
// (question_id, unique_identifier) is the hard Sybil-resistance gate.
export async function insertEnvelope(
  db: Executor,
  args: {
    questionId: string;
    uniqueIdentifier: string;
    answer: string;
    disclosedPredicates: Record<string, string>;
    agentSignature: string;
    delegationHashHex: string;
  },
): Promise<boolean> {
  const rows = (await db.execute(sql`
    INSERT INTO envelopes (
      question_id, unique_identifier, answer, disclosed_predicates,
      agent_signature, delegation_hash
    ) VALUES (
      ${args.questionId}, ${args.uniqueIdentifier}, ${args.answer},
      ${JSON.stringify(args.disclosedPredicates)}::jsonb,
      ${args.agentSignature}, ${args.delegationHashHex}
    )
    ON CONFLICT (question_id, unique_identifier) DO NOTHING
    RETURNING 1 AS inserted
  `)) as unknown as Rows<unknown>;
  return rows.length === 1;
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
  },
): Promise<void> {
  const options = args.options && args.options.length ? args.options : ["yes", "no"];
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${String(args.questionId)}::text, 0))`,
  );
  const rows = (await db.execute(sql`
    SELECT total_answers, by_predicate
    FROM aggregates
    WHERE question_id = ${args.questionId}
    FOR UPDATE
  `)) as unknown as Rows<{ total_answers: number; by_predicate: unknown }>;
  const row = rows[0];

  const choice = classifyAnswer(args.answer, options);
  const empty: Record<string, number> = {};
  for (const o of options) empty[o] = 0;
  const delta: Record<string, Record<string, number>> = {};
  for (const [k, v] of Object.entries(args.disclosedPredicates ?? {})) {
    const key = `${k}:${v}`;
    const bucket = delta[key] ?? { ...empty };
    delta[key] = bucket;
    if (choice !== null) bucket[choice] = (bucket[choice] ?? 0) + 1;
  }

  if (!row) {
    await db.execute(sql`
      INSERT INTO aggregates (question_id, total_answers, by_predicate, updated_at)
      VALUES (${args.questionId}, 1, ${JSON.stringify(delta)}::jsonb, now())
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

  await db.execute(sql`
    UPDATE aggregates
    SET total_answers = total_answers + 1,
        by_predicate = ${JSON.stringify(merged)}::jsonb,
        updated_at = now()
    WHERE question_id = ${args.questionId}
  `);
}

// Rebuild one question's aggregate from its remaining envelopes (same path used
// by both the revoke override and the self-invalidation listener). Assumes the
// caller holds the advisory lock / is inside the deletion transaction.
async function recomputeAggregate(db: Executor, questionId: string): Promise<void> {
  const remaining = (await db.execute(sql`
    SELECT answer, disclosed_predicates
    FROM envelopes
    WHERE question_id = ${questionId}
  `)) as unknown as Rows<{ answer: string; disclosed_predicates: unknown }>;
  const total = remaining.length;
  if (total === 0) {
    await db.execute(sql`DELETE FROM aggregates WHERE question_id = ${questionId}`);
    return;
  }
  const optionsRows = (await db.execute(sql`
    SELECT options FROM questions WHERE id = ${questionId}
  `)) as unknown as Rows<{ options: unknown }>;
  const options = normalizeOptions(optionsRows[0]?.options);
  const byPredicate = computeByPredicate(
    remaining.map((r) => ({
      answer: r.answer,
      disclosed_predicates: r.disclosed_predicates as Record<string, string>,
    })),
    options,
  );
  await db.execute(sql`
    INSERT INTO aggregates (question_id, total_answers, by_predicate, updated_at)
    VALUES (${questionId}, ${total}, ${JSON.stringify(byPredicate)}::jsonb, now())
    ON CONFLICT (question_id) DO UPDATE
    SET total_answers = EXCLUDED.total_answers,
        by_predicate = EXCLUDED.by_predicate,
        updated_at = now()
  `);
}

// ----- override (per-envelope revocation, §1.12) -------------------------

// Atomically delete one envelope and rebuild its question's aggregate. Returns
// true if an envelope was actually deleted, false if none matched (idempotent).
export async function deleteOneEnvelopeAndRecompute(
  db: Db,
  args: { questionId: string; uniqueIdentifier: string },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${String(args.questionId)}::text, 0))`,
    );
    const deleted = (await tx.execute(sql`
      DELETE FROM envelopes
      WHERE question_id = ${args.questionId} AND unique_identifier = ${args.uniqueIdentifier}
      RETURNING 1 AS deleted
    `)) as unknown as Rows<unknown>;
    if (deleted.length === 0) return false;
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
      (SELECT COUNT(DISTINCT unique_identifier) FROM envelopes)     AS respondents,
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
