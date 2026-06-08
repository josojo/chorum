# REFERRALS & REPUTATION — Design (v0.1)

Bootstrap incentive: let verified humans **refer** other humans, earn **reputation**
when those referees become active, and let reputation tiers grant a **board**
role with more say in chorum's future — **without ever publishing a nullifier**.

Status: IMPLEMENTED in the broker (steps 1–6 + 8 of §8 below; the web "invite a
friend" UI, step 7, is still to do). It builds on ARCHITECTURE_V0.md (verify-once,
broker-as-sole-verifier, voter-tag unlinkability) and reuses the existing
broker-signed credential machinery (`verify/credential.ts`).

Implemented surface:
- Endpoints: `POST /v1/referrals/create`, `POST /v1/referrals/stats`,
  `POST /v1/board/claim`, `GET /v1/board/roster`; `POST /v1/register` now accepts
  an optional `referral_code`.
- Tables: `referral_codes`, `referrals`, `reputation`, `board_members`
  (migration `0006_referrals_reputation_board.sql`, broker-private grants).
- Config (`CHORUM_BROKER_*`): `REFERRAL_MAX_ACTIVE_CODES` (20),
  `REFERRAL_CODE_TTL_DAYS` (90), `REP_PER_ACTIVE_REFERRAL` (1),
  `REP_BOARD_THRESHOLD` (10), `BOARD_CREDENTIAL_TTL_DAYS` (180).

---

## 1. The non-negotiable: never publish the nullifier

The Self nullifier (`registrations.unique_identifier`) is the most sensitive value
in the system. It is:

- **deterministic** per `(passport, scope="chorum-v1")`, so it is a permanent,
  scope-wide correlator for a single human;
- the **primary key** of `registrations` — one human, one row;
- deliberately **kept out of `envelopes`** (answers carry per-question voter tags
  `HMAC(s_q, question_id ‖ nullifier)`, ADR-098), so two answers from the same
  person are unlinkable at rest and unrecoverable once `s_q` is destroyed.

Using the nullifier as a referral pointer (publishing it, embedding it in a code,
letting a referee learn it) would collapse that pseudonymity: anyone who later
links the nullifier to one real-world fact de-anonymizes the person's whole answer
history, and a referee could *prove* who referred them. **The nullifier never
leaves the broker.**

## 2. Key insight: referral attribution needs no ZK

The broker already holds every nullifier — it is the trusted aggregator. So the
problem is **not** "hide the referral graph from the broker" (it already knows
everyone); it is "keep the referral link out of public / at-rest data." That is
solved by a strictly-safer primitive than the nullifier: an **opaque, single-use
capability token** (a referral code) that carries zero identity and that only the
broker can resolve back to a referrer.

**Self gives Sybil resistance for free.** One human = one passport = one nullifier
= one registration. A referrer cannot self-refer fake accounts; every referee must
be a distinct verified human document. The only residual abuse is real humans
colluding, which is rate-limited by the number of real passports.

ZK is reserved for the **governance layer** (§6), where board actions must not link
back to a member's answer history — and even there we start with a light
broker-issued anonymous credential, not a SNARK.

---

## 3. Referral codes (the capability token)

### 3.1 Mint — `POST /v1/referrals/create`

Caller authenticates the same way an asker does today (replay a `DelegationToken`,
or an asker session — see `routes/askers.ts`), which yields the **referrer's
nullifier** server-side. The browser/agent never asserts a raw identity.

Broker:
1. Generates a random, human-friendly code, e.g. `HUM-7K2P-9QXR`
   (≥80 bits entropy; Crockford base32, no ambiguous chars).
2. Stores **only `sha256(code)`** linked to the referrer's nullifier.
3. Returns the cleartext code **once** (never re-derivable from the DB).

Caps: a referrer may hold up to `REFERRAL_MAX_ACTIVE_CODES` live codes; each code
has `max_uses` (default 1) and an `expires_at` (default 90d). Codes are bearer
tokens — store hashed so a DB read-leak can't replay live codes.

### 3.2 Redeem — at `POST /v1/register`

The new person onboards Self exactly as today. The referral code travels as an
**optional plain field on the enrollment request — NOT inside the Self proof**
(keeps the proof minimal and the code off-chain). Add to `enrollmentBundleSchema`:

```ts
referral_code: z.string().trim().min(1).max(64).optional(),
```

After the existing Sybil bind succeeds (`upsertRegistration` returns non-null —
i.e. this is genuinely a *new* human), the broker, in the **same transaction**:

1. resolves `sha256(referral_code) → referrer_nullifier` (ignore silently if the
   code is unknown/expired/exhausted — never an oracle, §5 of V0);
2. rejects self-referral (`referrer == referee`) and double-attribution (a referee
   can be attributed to at most one referrer, enforced by PK on `referee`);
3. inserts a `referrals` row in state `pending`;
4. increments the code's `used_count`.

The referee learns nothing about the referrer (the code is random bytes). The
referrer is never revealed publicly. The link lives only in the broker DB that
already holds nullifiers.

> Note: redemption must run inside the register transaction so a new human and
> their referral edge commit atomically. If registration is rejected for any
> reason, no edge is recorded.

---

## 4. Reputation — credit on *activation*, not signup

A referral is worth points only once the referee becomes a **real participant**,
reusing the existing answer-credit thresholds (the asker-unlock bar:
`ASKER_UNLOCK_TOTAL_ANSWERS` = 50, `ASKER_UNLOCK_SIGNAL_ANSWERS` = 10). This
rewards community growth, not warm bodies.

Answer counts are already maintained atomically on `registrations`
(`answer_count`, `signal_count`, updated in the envelope path). Where those counters
are bumped, after the update check: *did this referee, who has a `pending`
referral edge, just cross the activation bar?* If so, in the same transaction:

1. flip the edge `pending → active`;
2. credit the referrer: `referrals_active += 1`, `reputation += REP_PER_ACTIVE_REFERRAL`.

`reputation` and `referrals_active` live on the referrer's `registrations` row
(or a sibling `reputation` table — see §5). Crediting is **idempotent** (guarded by
the edge state transition), so re-running the counter path can't double-credit.

Future weighting (out of scope for v0.1, noted so the schema doesn't block it):
small credit on activation + bonus when a referee *themselves* refers an active
user (2nd-degree), capped in depth to prevent pyramids.

---

## 5. Schema (Drizzle — edit `packages/web/src/db/schema.ts`, then `db:generate`)

All new tables are broker-only (broker is the sole reader/writer of identity data;
see `db/init/02-roles.sh`). Keyed on the raw nullifier, which already only the
broker can see.

```ts
// One row per referral code. Only the hash is stored; cleartext is shown once.
export const referralCodes = pgTable("referral_codes", {
  codeHash: text("code_hash").primaryKey(),            // sha256(code), hex
  referrerNullifier: text("referrer_nullifier").notNull(),
  maxUses: integer("max_uses").notNull().default(1),
  usedCount: integer("used_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
}, (t) => ({ byReferrer: index("referral_codes_referrer_idx").on(t.referrerNullifier) }));

// The referral graph. referee PK => at most one referrer per human.
export const referrals = pgTable("referrals", {
  refereeNullifier: text("referee_nullifier").primaryKey(),
  referrerNullifier: text("referrer_nullifier").notNull(),
  codeHash: text("code_hash").notNull(),
  state: text("state").notNull().default("pending"),   // 'pending' | 'active'
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
}, (t) => ({
  byReferrer: index("referrals_referrer_idx").on(t.referrerNullifier),
  // optional: check(state IN ('pending','active'))
}));

// Reputation rollup (could fold into registrations; separate keeps that table lean).
export const reputation = pgTable("reputation", {
  uniqueIdentifier: text("unique_identifier").primaryKey(),
  referralsActive: integer("referrals_active").notNull().default(0),
  score: integer("score").notNull().default(0),
  tier: text("tier").notNull().default("none"),        // none | bronze | silver | gold | board
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
```

Tier is derived from `score` at write time (or a view). Board threshold is a config
constant, e.g. `REP_BOARD_THRESHOLD`.

Migrations: edit `schema.ts` → `npm run db:generate` → commit both files (CI's
`db:check` enforces this). Grant the broker role `SELECT/INSERT/UPDATE` on the new
tables in a `db/init` roles step.

---

## 6. Governance / board — broker-issued anonymous credential

Chosen trust model: **broker-issued credential** (light, reuses `credential.ts`).
Goal: a board member can act (sit on the board, sign off, later vote) **without
linking that action to their passport nullifier or their answer history**.

### 6.1 Claim — `POST /v1/board/claim`

1. Caller authenticates with their `DelegationToken`/asker session → nullifier.
2. Broker checks `reputation.tier == 'board'` (or `score ≥ REP_BOARD_THRESHOLD`).
3. Caller supplies a **fresh governance public key** `gov_key` (Ed25519),
   generated client-side and unrelated to their agent_key.
4. Broker mints a **BoardCredential**: an Ed25519-signed claim, same pattern as
   `issueDelegationToken`, but binding `gov_key` and a tier — **and NOT the
   nullifier**:

```ts
type BoardCredential = {
  version: 1;
  scope: "chorum-gov-v1";   // separate scope from answers
  gov_key: string;          // base64 Ed25519 pubkey, caller-generated
  tier: "board";
  issued_at: string;
  expires_at: string;
  broker_signature: string; // Ed25519 over sha256(canonical claims)
};
```

Because the credential binds `gov_key` (fresh) instead of the nullifier, board
actions performed with `gov_key` are **unlinkable to the member's answers** by
anyone except the broker (which performed the issuance and could, if it chose, log
the link — acceptable under the current "broker is trusted" model; §6.3 is the
upgrade that removes even that).

The broker records that this nullifier has claimed (one live board credential per
human, to prevent stacking), but board *actions* reference only `gov_key`.

### 6.2 Use

Board actions (a signed endorsement, a vote on a proposal, membership listing)
present the BoardCredential + a signature by `gov_key` over the action. The board
roster can be published as a list of `gov_key`s and tiers — no nullifiers, no link
to answers.

### 6.3 Upgrade path to trustless (Semaphore-style), if/when wanted

Replace §6.1 issuance with: board members are leaves in a Merkle tree of
commitments; a vote is a ZK proof of membership + a per-vote nullifier under
`chorum-gov-v1`. Then not even the broker can link a vote to a member, and votes
are publicly verifiable on-chain (Celo, alongside Self). Out of scope for v0.1; the
`scope: "chorum-gov-v1"` separation above is chosen so this migration doesn't
disturb the answer-scope identity.

---

## 7. Abuse & privacy summary

| Vector | Mitigation |
| --- | --- |
| Fake referees (Sybil) | Self: one passport = one nullifier = one registration. Free. |
| Self-referral | Reject `referrer == referee` at redemption. |
| Double-attribution | `referrals.referee_nullifier` is PK. |
| Code farming / replay | Codes hashed at rest, `max_uses` + `expires_at`, active-code cap. |
| Warm-body referrals | Credit only on activation (50/10 answer bar). |
| Double-credit | Edge `pending→active` transition guards the increment (idempotent). |
| Nullifier leak | Nullifier never published; referral codes are identity-free bearer tokens. |
| Board action ↔ answers linkage | Governance under a separate scope + fresh `gov_key`; §6.3 removes broker link. |
| Oracle (probing codes) | Unknown/expired codes fail silently, like other reject reasons (V0 §5). |

## 8. Build order (when approved)

1. Schema (§5) + migration + role grants.
2. `verify/referralCode.ts` — generate/hash/validate codes.
3. `routes/referrals.ts` — `POST /v1/referrals/create` (+ `GET /v1/referrals/mine` stats).
4. `register.ts` — optional `referral_code`, redeem in-tx after Sybil bind.
5. Envelope counter path — activation check → flip edge + credit referrer.
6. `routes/board.ts` + extend `credential.ts` with `issueBoardCredential` (§6).
7. Web: referrer's "invite a friend" code/QR; onboarding accepts a code via link param.
8. Tests: redemption, self-referral reject, double-attribution, activation crediting
   idempotency, board claim gated on tier.
