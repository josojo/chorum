// Zod schemas for the broker wire formats.
//
// Mirror packages/proto/{self,enrollment,delegation,envelope,revocation,question}.json.
// `.strict()` matches pydantic's extra="forbid" and the §12 boundary-leakage
// assertion: an envelope body MUST contain exactly five top-level fields, a
// revocation exactly three.
//
// Wire keys stay snake_case (question_id, unique_identifier, disclosed_predicates,
// …) exactly as the Python broker emitted them; the Self proof bundle keeps the
// camelCase keys the Self app / bridge use (attestationId, publicSignals,
// userContextData).
//
// DelegationToken timestamps are kept as STRINGS end-to-end (never parsed into a
// Date for canonicalization). The Python broker's signed claim string equals the
// wire string, so reconstructing the signed payload verbatim from these strings
// reproduces both Python- and TS-issued signatures byte-for-byte.

import { z } from "zod";

// One verifiable Self proof (mirror packages/proto/self.json).
export const selfProofBundleSchema = z
  .object({
    attestationId: z.number().int(),
    proof: z.unknown(),
    publicSignals: z.array(z.unknown()),
    userContextData: z.string(),
  })
  .strict();
export type SelfProofBundle = z.infer<typeof selfProofBundleSchema>;

// POST /v1/register body (mirror packages/proto/enrollment.json).
//
// `referral_code` is optional (REFERRALS.md §3.2): a new human carries the code
// their referrer shared so the broker can attribute the referral after the Sybil
// bind. It travels as plain registration metadata — NOT inside any Self proof —
// so the proof stays minimal and the code stays off-chain. An unknown / expired /
// exhausted code is ignored silently and never fails registration.
export const enrollmentBundleSchema = z
  .object({
    self_proofs: z.array(selfProofBundleSchema).min(1),
    agent_key: z.string(),
    referral_code: z.string().trim().min(1).max(64).optional(),
  })
  .strict();
export type EnrollmentBundle = z.infer<typeof enrollmentBundleSchema>;

// Broker-issued, broker-signed session credential (proto/delegation.json).
export const delegationTokenSchema = z
  .object({
    version: z.literal(2),
    // Structural only. The exact value is FROZEN per environment and checked at
    // verify time against settings.selfScope (verify/delegation.ts) — a static
    // literal here cannot know staging's "staging-chorum-v1" vs prod's
    // "chorum-v1" (GH #97).
    scope: z.string(),
    unique_identifier: z.string(),
    disclosed_predicates: z.record(z.string(), z.string()),
    agent_key: z.string(),
    issued_at: z.string(),
    expires_at: z.string(),
    broker_signature: z.string(),
  })
  .strict();
export type DelegationToken = z.infer<typeof delegationTokenSchema>;

// POST /v1/envelopes body. `no_signal` is optional (defaults false) so existing
// agents that don't yet emit it keep working; when present it marks the §1.14
// no-signal branch (the agent had no relevant memory and skipped generation).
// It is unsigned metadata — the agent_signature still covers only
// question_id||answer||nonce||delegation_hash, so adding it does not change the
// signing input. Boundary-leakage (§12): at most six top-level fields.
export const envelopeSchema = z
  .object({
    question_id: z.string().uuid(),
    // The honest skill sends only a canonical option label here. The broker does
    // NOT persist this field verbatim: it classifies it to one of the question's
    // options and stores only that label (or "" for no_signal), so no free-form
    // text reaches the answers table at rest (#137, schema.ts envelopes.answer).
    answer: z.string(),
    no_signal: z.boolean().optional().default(false),
    nonce: z.string(),
    delegation_token: delegationTokenSchema,
    agent_signature: z.string(),
  })
  .strict();
export type Envelope = z.infer<typeof envelopeSchema>;

// POST /v1/envelopes/revoke body. Exactly 3 fields — boundary-leakage check.
export const envelopeRevocationSchema = z
  .object({
    question_id: z.string().uuid(),
    delegation_token: delegationTokenSchema,
    revocation_signature: z.string(),
  })
  .strict();
export type EnvelopeRevocation = z.infer<typeof envelopeRevocationSchema>;

// GET /v1/questions/open row.
export interface Question {
  question_id: string;
  text: string;
  topic: string | null;
  options: string[];
  created_at: string;
  closes_at: string;
  nonce: string;
}

// GET /v1/stats — privacy-safe site-wide counts for the public stats page.
export interface PlatformStats {
  registered_agents: number;
  questions: number;
  total_answers: number;
  respondents: number;
  answered_questions: number;
  avg_answers_per_question: number;
}

// POST /v1/askers/eligibility body. The asker proves a registered identity by
// presenting their broker-signed DelegationToken (ARCHITECTURE_V0.md §14.2 asker
// auth). Exactly one field — same `.strict()` boundary discipline as envelopes.
export const askerEligibilityRequestSchema = z
  .object({
    delegation_token: delegationTokenSchema,
  })
  .strict();
export type AskerEligibilityRequest = z.infer<typeof askerEligibilityRequestSchema>;

// Broker-issued, broker-signed asker login session (verify/askerSession.ts).
// Identity-only (no agent_key, unlike the DelegationToken): minted after a
// browser "Sign in with Self" scan proves the nullifier, replayed by the /ask
// form on submit. version 1 + kind discriminator so it can never be confused
// with a DelegationToken on the wire.
export const askerSessionSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("asker_session"),
    // Structural only — exact value checked at verify time (see delegation
    // schema note above and verify/askerSession.ts).
    scope: z.string(),
    unique_identifier: z.string(),
    issued_at: z.string(),
    expires_at: z.string(),
    broker_signature: z.string(),
  })
  .strict();
export type AskerSession = z.infer<typeof askerSessionSchema>;

// POST /v1/askers/login/start body. Optionally pick the disclosure profile;
// "minimal" (the default for a login) requests a single 18+ proof.
export const askerLoginStartRequestSchema = z
  .object({
    profile: z.enum(["minimal", "standard"]).optional(),
  })
  .strict();
export type AskerLoginStartRequest = z.infer<typeof askerLoginStartRequestSchema>;

// POST /v1/askers/login/start response — a Self request the browser renders as a
// QR. The phone scans it, the Self app posts the proof to the bridge, and the
// browser polls GET /v1/askers/login/:id/status.
export interface AskerLoginStartResponse {
  request_id: string;
  qr_urls: string[];
}

// GET /v1/askers/login/:id/status response. `status` is the scan lifecycle:
//   pending  — no verified proof yet; keep polling.
//   failed   — a proof landed but did not verify (or the identity is revoked).
//   complete — verified; `eligibility` carries the gate decision and, when the
//              identity verified, `asker_session` is the credential to replay.
export interface AskerLoginStatusResponse {
  status: "pending" | "failed" | "complete";
  reason: string | null;
  eligibility: AskerEligibilityResponse | null;
  asker_session: AskerSession | null;
}

// POST /v1/askers/session/verify body — the /ask form proves a logged-in asker
// by replaying the session minted at login. Exactly one field (boundary §12).
export const askerSessionVerifyRequestSchema = z
  .object({
    asker_session: askerSessionSchema,
  })
  .strict();
export type AskerSessionVerifyRequest = z.infer<typeof askerSessionVerifyRequestSchema>;

// Identity credential envelope for the referral/board endpoints (REFERRALS.md).
// An identity proves itself with EITHER its agent DelegationToken (the durable
// agent credential) OR a browser asker session ("Sign in with Self") — exactly
// one. Both resolve to the same nullifier via verify/identityAuth.ts. `.strict()`
// keeps the boundary discipline; the refine enforces the exclusive-or.
const identityCredentialsShape = {
  delegation_token: delegationTokenSchema.optional(),
  asker_session: askerSessionSchema.optional(),
} as const;

function exactlyOneCredential(v: {
  delegation_token?: unknown;
  asker_session?: unknown;
}): boolean {
  return (v.delegation_token == null) !== (v.asker_session == null);
}

// POST /v1/referrals/create and POST /v1/referrals/stats body — just the
// credential (the referrer is whoever the credential resolves to).
export const referralCreateRequestSchema = z
  .object(identityCredentialsShape)
  .strict()
  .refine(exactlyOneCredential, {
    message: "provide exactly one of delegation_token or asker_session",
  });
export type ReferralCreateRequest = z.infer<typeof referralCreateRequestSchema>;

export const referralStatsRequestSchema = referralCreateRequestSchema;
export type ReferralStatsRequest = z.infer<typeof referralStatsRequestSchema>;

// POST /v1/account/delete body — just the credential (the account to erase is
// whoever the credential resolves to). Right-to-erasure, issue #104.
export const accountDeleteRequestSchema = referralCreateRequestSchema;
export type AccountDeleteRequest = z.infer<typeof accountDeleteRequestSchema>;

// Receipt returned after a successful deletion — a count of what was erased, with
// no identifiers (so the receipt itself carries nothing linkable).
export interface AccountDeleteResponse {
  deleted: boolean;
  registration_deleted: boolean;
  deleted_answers: number;
  affected_questions: number;
}

// POST /v1/board/claim body — credential + a FRESH client-generated governance
// public key (base64 Ed25519, REFERRALS.md §6.1). The credential is bound to
// gov_key, never to the nullifier, so board actions don't link to answers.
export const boardClaimRequestSchema = z
  .object({ ...identityCredentialsShape, gov_key: z.string().min(1) })
  .strict()
  .refine(exactlyOneCredential, {
    message: "provide exactly one of delegation_token or asker_session",
  });
export type BoardClaimRequest = z.infer<typeof boardClaimRequestSchema>;

// Broker-issued anonymous board credential (verify/credential.ts). Same Ed25519
// primitive as the DelegationToken, but signed under a SEPARATE governance scope
// and binding gov_key + tier — NOT the nullifier. version 1 + kind discriminator
// so it can never be confused with a DelegationToken / asker session on the wire.
export const boardCredentialSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("board_credential"),
    scope: z.string(),
    gov_key: z.string(),
    tier: z.string(),
    issued_at: z.string(),
    expires_at: z.string(),
    broker_signature: z.string(),
  })
  .strict();
export type BoardCredential = z.infer<typeof boardCredentialSchema>;

// Response to POST /v1/referrals/create.
export interface ReferralCreateResponse {
  // The cleartext code, returned exactly once — the broker stores only its hash.
  code: string;
  expires_at: string;
}

// Response to POST /v1/referrals/stats — a referrer's referral + reputation
// dashboard.
export interface ReferralStatsResponse {
  unique_identifier: string;
  codes_minted: number;
  code_redemptions: number;
  pending_referrals: number;
  active_referrals: number;
  score: number;
  tier: string;
}

// Response to POST /v1/board/claim. `eligible` is the reputation gate; when true
// the broker mints and returns the credential. `reason` carries the block reason
// (or auth reason) otherwise.
export interface BoardClaimResponse {
  authorized: boolean;
  eligible: boolean;
  tier: string;
  score: number;
  required_score: number;
  credential: BoardCredential | null;
  reason: string | null;
}

// GET /v1/board/roster response — the public, nullifier-free board roster.
export interface BoardRosterResponse {
  members: Array<{ gov_key: string; tier: string }>;
}

// POST /v1/askers/eligibility response — authenticated asker gating decision
// (ARCHITECTURE_V0.md §14.2). snake_case to match the other broker wire shapes.
//
// `authorized` is the AUTH result (did the token verify against a live, non-
// revoked registration). `can_ask` is the GATE result (does the identity clear
// the unlock threshold). When authorized === false, the gate fields are zeroed
// and `auth_reason` carries why; when authorized === true, `reason` carries the
// gate block reason (null ⇔ can_ask).
export interface AskerEligibilityResponse {
  authorized: boolean;
  // A RejectionReason when authorized === false (or null when hidden); else null.
  auth_reason: string | null;
  // The verified identity (null when auth failed — we never echo an unverified id).
  unique_identifier: string | null;
  can_ask: boolean;
  is_admin: boolean;
  total_answers: number;
  signal_answers: number;
  required_total: number;
  required_signal: number;
  remaining_total: number;
  remaining_signal: number;
  // null ⇔ can_ask === true. One of AskerBlockReason otherwise.
  reason: string | null;
}

// Specific reasons the broker rejects a registration or an envelope. Values
// copied verbatim from the Python RejectionReason enum.
export const RejectionReason = {
  SCHEMA_INVALID: "schema_invalid",
  INTERNAL_ERROR: "internal_error",

  // --- registration (POST /v1/register) ---
  ENROLLMENT_MALFORMED: "enrollment_malformed",
  SELF_PROOF_INVALID: "self_proof_invalid",
  SELF_PROOF_EXPIRED: "self_proof_expired",
  SELF_BRIDGE_ERROR: "self_bridge_error",
  SELF_SCOPE_MISMATCH: "self_scope_mismatch",
  SELF_NULLIFIER_MISMATCH: "self_nullifier_mismatch",
  SELF_AGENT_BINDING_MISMATCH: "self_agent_binding_mismatch",
  SELF_REGISTRY_UNCONFIRMED: "self_registry_unconfirmed",
  PREDICATE_DERIVATION_FAILED: "predicate_derivation_failed",
  IDENTITY_ALREADY_BOUND: "identity_already_bound",
  IDENTITY_REVOKED: "identity_revoked",

  // --- per envelope (POST /v1/envelopes) ---
  TOKEN_EXPIRED: "token_expired",
  TOKEN_REVOKED: "token_revoked",
  BROKER_SIGNATURE_INVALID: "broker_signature_invalid",
  REGISTRATION_NOT_FOUND: "registration_not_found",
  REGISTRATION_AGENT_MISMATCH: "registration_agent_mismatch",
  DELEGATION_HASH_MISMATCH: "delegation_hash_mismatch",
  AGENT_SIGNATURE_INVALID: "agent_signature_invalid",
  AGENT_KEY_INVALID: "agent_key_invalid",
  QUESTION_NOT_FOUND: "question_not_found",
  QUESTION_NOT_OPEN: "question_not_open",
  QUESTION_CLOSED: "question_closed",
  NONCE_MISMATCH: "nonce_mismatch",
  SCOPE_INELIGIBLE: "scope_ineligible",
  // A signal answer whose leading word matches none of the question's options
  // (modulo no_signal). Rejected before INSERT so total_answers can never exceed
  // the sum of the per-option buckets (§1.1).
  ANSWER_UNCLASSIFIED: "answer_unclassified",
  DUPLICATE: "duplicate",

  // --- per-envelope override (POST /v1/envelopes/revoke; §1.12) ---
  ENVELOPE_NOT_FOUND: "envelope_not_found",

  // --- referrals & board (REFERRALS.md) ---
  // The referrer already holds the maximum number of live referral codes.
  REFERRAL_LIMIT_REACHED: "referral_limit_reached",
  // The identity's reputation is below the board threshold.
  BOARD_NOT_ELIGIBLE: "board_not_eligible",
  // The supplied governance public key is not a valid base64 Ed25519 key.
  GOV_KEY_INVALID: "gov_key_invalid",
} as const;

export type RejectionReason = (typeof RejectionReason)[keyof typeof RejectionReason];

// Response to POST /v1/envelopes.
export interface EnvelopeAck {
  accepted: boolean;
  reason: RejectionReason | null;
}

// Response to POST /v1/envelopes/revoke.
export interface RevocationAck {
  accepted: boolean;
  found: boolean | null;
  reason: RejectionReason | null;
}

// Response to POST /v1/register.
export interface RegisterAck {
  accepted: boolean;
  delegation_token: DelegationToken | null;
  reason: RejectionReason | null;
}
