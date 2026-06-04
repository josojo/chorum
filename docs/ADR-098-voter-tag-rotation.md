# ADR-098 — Voter-tag linkage secret: per-question, wrapped, destroyed on close

- **Status:** Accepted — implemented in the broker. Supersedes the v0 global non-rotatable secret and the V2 calendar-epoch rotation for the answers table.
- **Issue:** [#98](https://github.com/josojo/hearme/issues/98) — `voterTagSecret` is global and non-rotatable
- **Date:** 2026-06-04
- **References:** `ARCHITECTURE_V0.md` §1.4, `ARCHITECTURE_V2.md` (epoch rotation), `packages/broker/src/{voterTag,questionSecret,secretsDb}.ts`, `packages/broker/src/queries.ts` (`invalidateRegistrationAndVotes`), `packages/broker/src/startupChecks.ts`

## Context

Each envelope is stored under a per-question voter tag, not the raw Self nullifier:

```
voter_tag = base64( HMAC-SHA256( linkage_secret, "hearme-voter-tag-v1" | question_id | nullifier ) )
```

In v0 `linkage_secret` was a single global, deliberately non-rotatable secret
(`HEARME_BROKER_VOTER_TAG_SECRET`), non-rotatable because the broker re-derives a
person's per-question tags to revoke / invalidate their answers.

The cost (#98): the unlinkability of **every answer ever submitted** rested on one
live secret. If the box is breached and that secret **plus** the `registrations`
table (raw nullifiers) leak, all historical answers become re-linkable to people —
and the liability **accumulates monotonically** the longer the system runs.

## Decision

Replace the global secret with an **independently-random per-question secret
`s_q`**, minted lazily on a question's first answer and **destroyed a grace period
after the question closes**. `s_q` is stored **wrapped** (AES-256-GCM under an
env/SSM master key) in a broker-owned database.

```
s_q          = 32 random bytes (CSPRNG), never derived from a longer-lived key
stored blob  = iv | gcm_tag | AES-256-GCM(master_key, s_q)      -- in question_secrets
voter_tag    = base64( HMAC-SHA256(s_q, "hearme-voter-tag-v1" | question_id | nullifier) )
```

- **Lazy mint.** On the first answer the broker generates `s_q`, wraps it, and
  inserts it (`ON CONFLICT (question_id) DO NOTHING` so concurrent first-answers
  race to one winner). `closes_at` is copied into the row for the reaper.
- **Destroy at close + grace.** A reaper nulls the wrapped secret once the question
  closed more than the grace window ago, keyed on `closes_at` (no question status
  flip needed). After this, **no one — not even the broker — can re-derive that
  question's tags from a nullifier.** The question's answers are cryptographically
  orphaned from every identity, permanently.

This is "epoch = question": the finest natural epoch, tied to a real lifecycle
event. It subsumes the V2 calendar-epoch rotation **for the answers table**.
(Epoch-rotated Self *scopes*, where even the nullifier rotates, remain a separate,
deeper V2 change and are out of scope here.)

### Two forms of protection, two threats

1. **At rest (wrap).** A DB-only leak — dump, read-replica, stolen snapshot —
   *without* the box's env/SSM master key yields only ciphertext. This restores
   §1.4's "a DB dump alone can't relink" property even for *open* questions.
2. **Forward secrecy (destroy).** Forward secrecy comes from **destroying the
   wrapped secret**, not from the master key: the master key cannot decrypt a row
   that's been nulled, so a closed-and-destroyed question is unlinkable even to a
   holder of the master key. The master key is therefore **not** a reincarnation of
   the #98 global secret — it can only ever decrypt the *live* working set.

### Storage: co-located broker-owned database

`s_q` lives in a broker-owned database (`question_secrets` in a `hearme_secrets`
DB), **co-located on the same RDS instance** as the main DB in production.

- **Why a broker-owned DB, not the shared schema.** `hearme_broker` has only
  `USAGE` (not `CREATE`) on the shared `hearme` schema, so it can't create the
  table there; and keeping `question_secrets` out of the shared schema avoids the
  `verify-db.sh` table-boundary check and the drizzle migration/`db:check` drift
  machinery. The broker owns `hearme_secrets`, so its `CREATE TABLE IF NOT EXISTS`
  (`secretsDb.ts`) just works. `hearme_web` / `hearme_classifier` have no role or
  connection on it.
- **Why co-located is fine.** The main prod RDS runs at 1-day backup retention, so
  a separate short-retention instance would not meaningfully shorten the unlink
  horizon — it is dominated by `grace` (7 days). The instance separation's only
  remaining benefit (a main-DB dump containing zero linkage material) is recovered
  more cheaply by the **wrap**: the co-located blob is ciphertext without the
  master key. So we co-locate and skip a second billed RDS instance.

### Unlink horizon

`close + grace + RDS_retention` (instance-wide retention, currently 1 day; `grace`
= 7 days). The accumulating liability is **bounded** to the live working set
(open questions + a trailing `grace + retention` window of recently-closed ones);
it no longer grows without limit. A breach also requires the env/SSM master key on
top of the DB to relink anything at all.

## Consequences

**Gained**
- Liability stops accumulating; breach blast radius is bounded to the live working
  set, and a DB-only leak (no master key) can't relink even that.
- The static, non-rotatable global secret is gone; `startupChecks` now refuses the
  dev master key and the dev secrets DSN in production.

**Given up (accepted)**
- **Self-invalidation and per-answer revoke no longer reach _closed_ questions.**
  Without `s_q` the broker can't locate a person's envelopes in a closed question.
  Acceptable — a closed question's aggregate is already published and should be
  immutable — but a real semantic change: invalidation goes from "scrub a person's
  answers everywhere, forever" to "scrub only from still-open questions."
- The master key must stay **stable**; rotating it orphans the still-live wrapped
  secrets (closed ones are already destroyed, so they're unaffected).
- A second DSN/connection pool. The envelope INSERT (main DB) and the `s_q`
  lookup/create (`hearme_secrets`) are separate connections, so they can't share
  one transaction — handled by making `s_q` creation idempotent and ordering it
  before tag derivation.

**Requirements (non-negotiable for the deletion to be real)**
1. `s_q` is independently random per question (32 CSPRNG bytes) — never derived
   from the master key (the master only wraps it), or deletion is cosmetic.
2. The master key lives outside the DB (env/SSM) and is least-privilege / audited.
3. Per-person counters (`registrations.answer_count/signal_count`, keyed by the raw
   nullifier) are untouched — the answer-credit economy and one-answer-per-human-
   per-question PK both survive unchanged.

## Alternatives considered

- **Accept the v0 global secret as-is.** Rejected: leaves the unbounded liability.
- **V2 calendar-epoch rotation (~monthly).** Per-question is strictly finer and
  self-pruning; destruction follows the question's lifecycle, not a calendar tick.
- **Separate short-retention secrets RDS instance.** The original plan, on the
  assumption that the main instance's retention was long. On discovering the main
  prod RDS is already at **1-day** retention, a second instance stopped being worth
  ~$13/mo + the ops: the horizon is dominated by `grace`, and the wrap recovers the
  "main dump can't relink" property without it. Revisit only if `grace` is cut to
  near-zero *and* the main retention is raised.
- **KMS-wrapped per-question keys / Secrets-Manager hard-delete (off-RDS).**
  Strongest real-deletion guarantee but most new infra. Deferred; the AES-GCM wrap
  under one env/SSM master key is the pragmatic middle.

## Implementation checklist (tracking #98 acceptance criteria)

- [x] Second broker DSN (`HEARME_BROKER_SECRETS_DATABASE_URL`) + pool (`secretsDb.ts`).
- [x] `question_secrets(question_id PK, secret BYTEA, closes_at, created_at,
      destroyed_at)`, broker-created in the `hearme_secrets` DB.
- [x] AES-256-GCM wrap/unwrap of `s_q` under `HEARME_BROKER_VOTER_TAG_MASTER_KEY`
      (`questionSecret.ts`); the plaintext `s_q` never touches the DB.
- [x] Lazy create on first envelope (`ON CONFLICT DO NOTHING`), before tag
      derivation; `voterTagForInsert` / `voterTagIfLive` (`voterTag.ts`).
- [x] Close-lifecycle reaper nulls `s_q` at `close + grace` (`QuestionSecretReaper`).
- [x] Revoke + `invalidateRegistrationAndVotes` scoped to questions whose `s_q`
      still exists; closed-question carve-out documented in code.
- [x] `s_q` / master key never interpolated into logs.
- [x] Retire the global-secret startup check; add dev-default checks for the master
      key and the secrets DSN (`startupChecks.ts`).
- [x] Dev/CI: broker-owned `hearme_secrets` DB (`db/init/04-secrets-db.sh`, compose);
      tests cover wrap-at-rest and the destroy-on-close lifecycle.
- [ ] **Deployment:** generate the master key + push to SSM (staging, prod); create
      the co-located `hearme_secrets` DB (prod via `bootstrap-rds.sh`; existing
      boxes via a one-time manual `CREATE DATABASE`).
- [ ] *(Optional)* move the secrets off-RDS to KMS/Secrets-Manager for a stronger
      real-deletion guarantee if the threat model tightens.
