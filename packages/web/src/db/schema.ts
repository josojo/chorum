// Drizzle schema — hand-mirror of packages/web/drizzle/0000_init.sql.
// Keep in sync with that file (and with the broker's Python models when
// they land in packages/broker/src/hearme_broker/db/).

import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  bigint,
  jsonb,
  index,
  primaryKey,
  check,
} from "drizzle-orm/pg-core";

export const askers = pgTable("askers", {
  id: uuid("id").primaryKey().defaultRandom(),
  displayName: text("display_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const questions = pgTable(
  "questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    askerId: uuid("asker_id").references(() => askers.id),
    text: text("text").notNull(),
    topic: text("topic"),
    nonce: text("nonce")
      .notNull()
      .default(sql`encode(gen_random_bytes(16), 'base64')`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    closesAt: timestamp("closes_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("open"),
    // Ordered list of poll options. Default ['yes','no'] keeps every legacy
    // poll a two-option poll; arbitrary labels are allowed (2..8).
    options: jsonb("options")
      .$type<string[]>()
      .notNull()
      .default(sql`'["yes","no"]'::jsonb`),
    scope: text("scope").notNull().default("worldwide"),
    country: text("country"),
    continent: text("continent"),
  },
  (t) => ({
    statusChk: check(
      "questions_status_chk",
      sql`${t.status} IN ('open', 'closed')`,
    ),
    scopeChk: check(
      "questions_scope_chk",
      sql`${t.scope} IN ('worldwide','continent','country')`,
    ),
    optionsChk: check(
      "questions_options_chk",
      sql`jsonb_typeof(${t.options}) = 'array' AND jsonb_array_length(${t.options}) BETWEEN 2 AND 8`,
    ),
  }),
);

export const envelopes = pgTable(
  "envelopes",
  {
    questionId: uuid("question_id")
      .notNull()
      .references(() => questions.id),
    uniqueIdentifier: text("unique_identifier").notNull(),
    answer: text("answer").notNull(),
    disclosedPredicates: jsonb("disclosed_predicates").notNull(),
    agentSignature: text("agent_signature").notNull(),
    delegationHash: text("delegation_hash").notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.questionId, t.uniqueIdentifier] }),
    questionIdx: index("envelopes_question_id_idx").on(t.questionId),
    submittedIdx: index("envelopes_submitted_at_idx").on(t.submittedAt),
  }),
);

export const aggregates = pgTable("aggregates", {
  questionId: uuid("question_id")
    .primaryKey()
    .references(() => questions.id),
  totalAnswers: integer("total_answers").notNull().default(0),
  byPredicate: jsonb("by_predicate").notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const revocations = pgTable("revocations", {
  delegationHash: text("delegation_hash").primaryKey(),
  revokedAt: timestamp("revoked_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const registrations = pgTable(
  "registrations",
  {
    uniqueIdentifier: text("unique_identifier").primaryKey(),
    agentKey: text("agent_key").notNull(),
    disclosedPredicates: jsonb("disclosed_predicates").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => ({
    agentKeyIdx: index("registrations_agent_key_idx").on(t.agentKey),
  }),
);

export const selfNullifierInvalidations = pgTable("self_nullifier_invalidations", {
  uniqueIdentifier: text("unique_identifier").primaryKey(),
  source: text("source").notNull(),
  chainId: text("chain_id"),
  blockNumber: bigint("block_number", { mode: "number" }).notNull(),
  logIndex: integer("log_index").notNull(),
  txHash: text("tx_hash").notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const selfChainCursors = pgTable("self_chain_cursors", {
  name: text("name").primaryKey(),
  lastBlock: bigint("last_block", { mode: "number" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
