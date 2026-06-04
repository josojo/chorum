# ADR-098 — Voter-tag linkage secret: per-question, destroyed on close

- **Status:** Accepted — broker implementation landed; production provisioning (separate secrets RDS) pending. Supersedes the v0 global non-rotatable secret and the V2 calendar-epoch rotation for the answers table.
- **Issue:** [#98](https://github.com/josojo/hearme/issues/98) — `voterTagSecret` is global and non-rotatable
- **Date:** 2026-06-04
- **References:** `ARCHITECTURE_V0.md` §1.4, `ARCHITECTURE_V2.md` (epoch rotation), `packages/broker/src/voterTag.ts`, `packages/broker/src/queries.ts` (`invalidateRegistrationAndVotes`), `packages/broker/src/startupChecks.ts:41`

## Context

Each envelope is stored under a per-question voter tag, not the raw Self nullifier:

```
voter_tag = base64( HMAC-SHA256( linkage_secret, "hearme-voter-tag-v1" | question_id | nullifier ) )
```

In v0 `linkage_secret` is a single global, deliberately non-rotatable secret
(`HEARME_BROKER_VOTER_TAG_SECRET`). It is non-rotatable because the broker
re-derives a person's per-question tags to revoke / invalidate their answers;
rotating it orphans that ability.

The cost (#98): the unlinkability of **every answer ever submitted** rests on one
live secret. If the box is breached and that secret **plus** the `registrations`
table (raw nullifiers) leak, all historical answers become re-linkable to people.
Worse, the liability **accumulates monotonically** — the longer the system runs,
the larger the permanently-unrotatable re-identification honeypot.

## Decision

Replace the global secret with an **independently-random per-question secret
`s_q`, destroyed a short grace period after the question is officially closed.**

- Generate 32 random bytes `s_q` lazily on the first envelope for a question
  (`INSERT ... ON CONFLICT (question_id) DO NOTHING` so concurrent first-answers
  race to a single winner). `s_q` lives in a **separate Postgres instance** (see
  Storage); the broker reads it to derive the tag.
- `voter_tag = HMAC-SHA256(s_q, "hearme-voter-tag-v1" | question_id | nullifier)`.
  (`question_id` in the input is now redundant but kept for defence in depth.)
- The broker needs `s_q` for the whole open window (it derives the tag on every
  insert) and through a grace window after `status: open → closed` (in-flight
  revocations, aggregate recompute, dispute period).
- At `close + grace`: null the ciphertext column and stamp `destroyed_at`. After
  this point **no one — not even the broker — can re-derive that question's tags
  from a nullifier.** The question's answers are cryptographically orphaned from
  every identity, permanently.

This is "epoch = question": the finest natural epoch, with the destruction trigger
tied to a real lifecycle event rather than a calendar tick. It subsumes the V2
calendar-epoch rotation **for the answers table**. (Epoch-rotated Self *scopes*,
where even the nullifier rotates, remain a separate, deeper V2 change and are out
of scope here.)

### Storage: separate short-retention Postgres instance

`s_q` lives in a **dedicated Postgres instance** (`question_secrets` table),
**separate** from the main RDS instance that holds `envelopes` / `registrations` /
`questions`. This is the key move: RDS automated backups are **instance-wide**, so
you cannot have durable backups of envelopes and short-retention secrets in one
instance — the secret's deletion horizon would silently inherit the main instance's
long retention. Splitting the instances decouples them.

- **Main instance:** envelopes / registrations / questions. Long retention — the
  durable-backup requirement that motivated the RDS move (#96/#111) is preserved.
- **Secrets instance:** `question_secrets` only. Backup retention set to the
  minimum (0–1 day). It holds *only* linkage key material — nothing whose loss
  matters for durability, since a destroyed `s_q` is *meant* to be unrecoverable.
- **Isolation by construction:** only the broker has credentials to the secrets
  instance. `hearme_web`, `hearme_classifier`, analytics/export, and any read
  replica of the main instance physically cannot reach it. A dump of the main
  instance — the §1.4 honeypot concern — contains no linkage secret at all,
  restoring the original "a DB dump alone can't relink" property.
- *(Optional hardening, not required by this design:* also wrap `s_q` under an
  env/SSM `master_key` so a breach of the secrets instance alone, without the box
  env, yields ciphertext. Cheap; orthogonal to the deletion guarantee.)*

### Migration trigger / unlink horizon

- **Unlink horizon** for a closed question = `close + grace +
  secrets_instance_retention` (e.g. 0–1 day) — independent of, and far shorter
  than, the main instance's retention.
- The accumulating liability is **bounded** to: all currently-open questions, plus
  a trailing `grace + secrets_retention` window of recently-closed ones. It no
  longer grows without limit.

## Consequences

**Gained**
- Liability stops accumulating; breach blast radius is bounded to the live working
  set, not "every answer ever," with a short (0–1 day) trailing window.
- The main instance — the §1.4 honeypot — holds **no** linkage secret, so a dump,
  read-replica, or stolen snapshot of it cannot relink on its own.
- The `startupChecks.ts:41` "non-rotatable / dev-default global secret" framing goes
  away; the static global `VOTER_TAG_SECRET` is retired.

**Given up (accepted)**
- **Self-invalidation and per-answer revoke no longer reach _closed_ questions.**
  `invalidateRegistrationAndVotes` re-derives a person's tag per `question_id`;
  without `s_q` it cannot find their envelopes in a closed question. This is
  acceptable — a closed question's aggregate is already published and should be
  immutable — but it is a real semantic change: invalidation goes from "scrub a
  person's answers everywhere, forever" to "scrub only from still-open questions."
- A second Postgres instance to provision, monitor, and connect to (second DSN in
  broker config). The envelope INSERT (main) and the `s_q` lookup/create (secrets)
  are on separate connections, so they cannot share one transaction — handled by
  making `s_q` creation idempotent and ordering it *before* tag derivation.

**Requirements (non-negotiable for the deletion to be real)**
1. `s_q` is independently random per question (32 CSPRNG bytes) — not derived from
   any longer-lived key, or deletion is cosmetic.
2. The secrets instance is **broker-only** and **short-retention**; the main
   instance has no grant or network path to it. Verify its backups really are
   short — that is the entire unlink horizon.
3. Per-person counters (`registrations.answer_count/signal_count`, keyed by the raw
   nullifier) are untouched — the answer-credit economy and one-answer-per-human-
   per-question PK both survive unchanged.

## Alternatives considered

- **Accept the v0 global secret as-is.** Rejected: the issue's core harm is the
  unbounded accumulating liability; doing nothing leaves it.
- **V2 calendar-epoch rotation (~monthly).** Caps blast radius at one epoch, but the
  current epoch's secret is always live, questions straddling boundaries are awkward,
  and destruction is a calendar event divorced from any question's lifecycle.
  Per-question is strictly finer and self-pruning.
- **Single RDS instance (wrapped, short retention).** Rejected: RDS backup retention
  is **instance-wide**, so you cannot keep durable backups of envelopes while giving
  secrets a short deletion horizon — the secret silently inherits the long retention.
  This is the trap that drove the separate-instance choice.
- **Crypto-shred (ciphertext in main RDS, wrapping key in a tiny external store).**
  Keeps all data in one durable instance and shreds by destroying a small external
  key. Strong, but introduces a second store *and* an encryption layer; the
  separate-instance path achieves the same bounded horizon with only plain Postgres.
- **KMS-wrapped per-question key / Secrets-Manager hard-delete.** Strongest real-
  deletion guarantee but most new infra. Revisit if the 0–1 day trailing window on
  the secrets instance ever becomes an unacceptable exposure.

## Implementation checklist (tracking #98 acceptance criteria)

- [x] Second broker DSN (`HEARME_BROKER_SECRETS_DATABASE_URL`) + pool (`secretsDb.ts`).
- [x] `question_secrets(question_id PK, secret BYTEA, closes_at, created_at,
      destroyed_at)`, broker-created in the secrets instance (`secretsDb.ts`).
- [x] Lazily create `s_q` on first envelope (`ON CONFLICT DO NOTHING`), *before*
      tag derivation; `voterTagForInsert` / `voterTagIfLive` read `s_q` from the
      secrets instance (`questionSecret.ts`, `voterTag.ts`).
- [x] Close lifecycle reaper: at `close + grace`, null `s_q` + stamp `destroyed_at`
      (`QuestionSecretReaper`, keyed on `closes_at`).
- [x] `invalidateRegistrationAndVotes` + revoke: scope to questions whose `s_q`
      still exists; closed-question carve-out documented in code.
- [x] `s_q` never interpolated into logs (reaper logs counts only).
- [x] Retire the static `VOTER_TAG_SECRET` global-secret startup check; add the
      separate-instance guard (`startupChecks.ts`).
- [x] Dev/CI parity: broker-owned `hearme_secrets` DB (`db/init/04-secrets-db.sh`,
      compose), tests cover the destroy-on-close lifecycle.
- [ ] **Deployment:** provision the separate secrets RDS (prod), retention 0–1 day,
      broker-only creds; bootstrap `hearme_secrets` + `hearme_broker` on it. On any
      **existing** box the init script won't re-run — create the DB once by hand.
- [ ] *(Optional)* KMS-wrap `s_q` at rest; revisit moving secrets off RDS.
