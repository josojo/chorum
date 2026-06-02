// Drizzle schema — THE single source of truth for the shared Postgres schema.
//
// The SQL migrations under drizzle/migrations/ are GENERATED from this file
// (`npm run db:generate`); never hand-edit them. Extensions (pgcrypto) live in
// db/init/00-extensions.sql since drizzle-kit doesn't model them.
//
// CI (`npm run db:check`, in .github/workflows/ci.yml) fails if this file has
// changes that haven't been regenerated into a committed migration. Workflow:
// edit schema.ts → `npm run db:generate` → commit both.

import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  bigint,
  boolean,
  jsonb,
  index,
  primaryKey,
  check,
} from "drizzle-orm/pg-core";

export const askers = pgTable("askers", {
  id: uuid("id").primaryKey().defaultRandom(),
  displayName: text("display_name").notNull(),
  // The verified Self nullifier of the asker, when they authenticated with a
  // DelegationToken (asker auth, ARCHITECTURE.md §15.3). NULL for legacy /
  // unauthenticated display-only rows. The broker verifies the credential and
  // returns this identifier; the web app never derives it from user input.
  uniqueIdentifier: text("unique_identifier"),
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
    // ISO 3166-1 alpha-2 (e.g. 'US', 'DE', 'JP'). NULL when scope != 'country'.
    scope: text("scope").notNull().default("worldwide"),
    country: text("country"),
    // Two-letter continent code: AF, AN, AS, EU, NA, OC, SA.
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
    continentChk: check(
      "questions_continent_chk",
      sql`${t.continent} IS NULL OR ${t.continent} IN ('AF','AN','AS','EU','NA','OC','SA')`,
    ),
    scopeGeoChk: check(
      "questions_scope_geo_chk",
      sql`(${t.scope} = 'worldwide' AND ${t.country} IS NULL AND ${t.continent} IS NULL)
        OR (${t.scope} = 'continent' AND ${t.country} IS NULL AND ${t.continent} IS NOT NULL)
        OR (${t.scope} = 'country' AND ${t.country} IS NOT NULL AND ${t.continent} IS NOT NULL)`,
    ),
    scopeIdx: index("questions_scope_idx").on(t.scope),
    countryIdx: index("questions_country_idx").on(t.country),
    continentIdx: index("questions_continent_idx").on(t.continent),
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
    // §1.14: the agent had no relevant memory and skipped generation, so this
    // envelope carries no opinion (answer is conventionally empty). A first-class
    // aggregate bucket ("had no formed view"), and the signal/non-signal split
    // the asker-credit gate counts on (§15.3). Unsigned metadata — NOT covered by
    // agent_signature (which signs question_id||answer||nonce||delegation_hash);
    // it only affects the answerer's own credit count, so the surface is bounded.
    noSignal: boolean("no_signal").notNull().default(false),
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
  // Grand count of accepted envelopes, no_signal included.
  totalAnswers: integer("total_answers").notNull().default(0),
  // Per-(predicate,value) bucket option tallies — SIGNAL answers only, e.g.
  // {"region:EU": {"yes": 30, "no": 12}}. no_signal envelopes are excluded here
  // and counted in the dedicated fields below (§1.14), so the option bars stay
  // a clean breakdown of formed views.
  byPredicate: jsonb("by_predicate").notNull().default({}),
  // First-class "no formed view" aggregation (§1.14). `noSignalTotal` is the
  // headline count of no_signal envelopes; `noSignalByPredicate` is the same
  // count split per disclosed bucket, e.g. {"region:EU": 5, "age_band:25-34": 3},
  // so consumers can see "X% of EU 25-34 had no formed view".
  noSignalTotal: integer("no_signal_total").notNull().default(0),
  noSignalByPredicate: jsonb("no_signal_by_predicate").notNull().default({}),
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

// Asker admins — the DB-backed bootstrap valve of the answer-credit economy
// (ARCHITECTURE.md §15.3). An identity listed here bypasses the asker unlock
// threshold entirely (it may open questions with zero earned credit), so the
// network can be seeded with questions before there's a body of answerers to
// earn against. Keyed by the Self nullifier (`unique_identifier`) — the same key
// the gate decides on — so a row can exist before the identity has ever asked or
// even onboarded an agent. Broker-owned and read live (no restart), the DB
// complement to the static HEARME_BROKER_ASKER_ADMIN_IDENTIFIERS env allowlist;
// the broker treats effective-admin as the union of the two. `label` is an
// operator-set human note (the nullifier is opaque, so it's the only readable
// handle) — e.g. the display name they ask under, or "founder seed".
export const askerAdmins = pgTable("asker_admins", {
  uniqueIdentifier: text("unique_identifier").primaryKey(),
  label: text("label"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

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
