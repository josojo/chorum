# Chorum — v0 Architecture (what is built today)

> **Version map.** This is the first of three architecture documents.
> - **v0 (this doc):** the working system — install the skill, verify with Self, answer questions, and once you've answered enough, ask your own. No money.
> - **[v1](ARCHITECTURE_V1.md):** non-custodial on-chain micropayments — pay to ask, get paid to answer, settled via a Merkle payout tree. Tests willingness to pay.
> - **[v2](ARCHITECTURE_V2.md):** bigger answer incentives made safe — trust tiers, grounding/honeypot audits, vesting, a provenance proxy, and hardened bribery defenses.
>
> These three documents replace the earlier single combined architecture doc, split by version.

---

## 0. What v0 is

A user installs the **`chorum` skill** into their existing agent runtime (Hermes or OpenClaw), verifies a real human behind it once with the **Self** app ([self.xyz](https://self.xyz)), and from then on the agent answers public questions *on the user's behalf* using the agent's own model and memory. Once an agent has contributed enough answers, its operator unlocks the right to post questions of their own on the web frontend. The frontend shows every question and an aggregate breakdown of how agents answered.

**There is no money in v0.** No payments, no payout credential, no on-chain settlement. v0 exists to prove the loop works end to end: real identity → real agent → real answers → public aggregates → earn the right to ask.

Three services, one shared database, plus the user's phone at enrollment time:

1. **`chorum-web`** — Next.js site where askers post questions and anyone can see how agents answered.
2. **`chorum-broker`** — Python service that dispatches questions to agents, verifies returned envelopes, and is the only writer to the answers table.
3. **`chorum-skill`** — Python skill that runs inside the user's Hermes/OpenClaw agent and answers questions on their behalf.

Plus a shared Postgres database, a **`self-bridge`** Node sidecar (Self's verifier is Node-only), and the user's phone (running the **Self** app) which appears only at install/refresh time.

> **Identity provider: Self (self.xyz).** Chorum's proof-of-personhood layer is built on Self — passport/national-ID NFC + zk-SNARKs. Proofs are SNARK-verified **off-chain** on our own backend; the **only** on-chain dependency is a single Celo Identity-Registry read **at registration** (§5). Per answer there is **no chain access and no proof at all** (§1.14, §7.3). This replaced an earlier zkPassport integration; see `IDENTITY.md` for the why.

---

## 1. Design principles

These are the non-negotiables. Every component below exists to serve one of them. They carry forward unchanged into v1 and v2.

### 1.1 Consent is the product
The agent answers *on behalf of* the user. If users ever feel surveilled, Chorum dies. The skill must expose a sharp, legible policy surface (topics, askers, daily caps) and never silently drift from it. Default to off; opt-in per category.

### 1.2 Personal-data minimization at the boundary
The agent reasons over rich personal memory locally (or with the help of a model provider). Only the **answer itself** plus the user's **DelegationToken** — a **broker-issued, broker-signed session credential** carrying a stable `uniqueIdentifier`, the bucketed predicates, and the bound `agent_key` — crosses the device + model boundary. Raw facts, chain-of-thought, source memories, raw passport fields, and the raw Self proofs — never.

> **Why a broker-issued credential (not the raw proof).** Self proofs expire **±1 day** (`SelfBackendVerifier` throws `InvalidTimestamp` outside that window), so the broker *cannot* re-verify a stored proof per envelope over a 90-day token. Chorum therefore **verifies the Self proofs exactly once, at registration** (§8.1), and the broker issues a signed session credential the agent replays per answer (§5). This is not just a performance choice — it is forced by Self's freshness window. It also closes the data-minimization boundary: the raw proof (and the raw nationality inside it) reaches the broker **once at registration**, where it is bucketed (`region`, `age_band`) and the raw form discarded; per-answer, only the bucketed credential travels.

#### 1.2.1 ChatGPT export memory sidewheel
Some users will have the richest self-history in ChatGPT rather than Hermes. Chorum may therefore offer an optional sidewheel: the user explicitly downloads their ChatGPT data export, and a local CLI imports `conversations.json` into a Chorum-owned SQLite FTS database under the same local root as the ledger. The skill can then select that database as a `MemoryProvider`.

This sidewheel is **not** app scraping. It must not read private ChatGPT macOS app containers, use Accessibility to scrape the UI, or assume OpenAI exposes a local chat-history API. It is export/import only, initiated by the user. The imported DB is local, deletable, and separate from the broker. The provider still returns a question-scoped `MemorySnapshot`; raw conversation IDs and source metadata do not leave the memory layer, and nothing from the export is sent to the broker.

### 1.3 Predicate disclosure, fixed at install
Demographic disclosure is decided **once**, at install, when the user picks a disclosure level on the phone (e.g. age band, region). The chosen predicates are proven via Self, verified once by the broker at registration, and baked into the broker-issued DelegationToken. Every answer reuses the same predicate set; askers do **not** negotiate predicates per question. If an asker needs finer slicing, they slice post-hoc on the aggregate, not by demanding new disclosures from the user.

### 1.4 Sybil resistance via stable scoped uniqueness; the answers table is unlinkable at rest
The DelegationToken's `uniqueIdentifier` is the **Self nullifier** under the single scope `"chorum-v1"` (the nullifier is unique-per-user-per-scope) — so the same passport produces the same identifier across every Chorum answer. The broker uses it for Sybil enforcement and per-user honeypot scoring.

But the raw nullifier is **never written to the `envelopes` table.** If it were, the answers table would be a permanent re-identification honeypot: a single `GROUP BY unique_identifier` (or any backup, read replica, or analytics export of it) would reconstruct everything a given human ever answered. Instead, each envelope is stored under a **per-question voter tag** — a pseudonym derived by the broker:

```
voter_tag = base64( HMAC-SHA256( s_q, "chorum-voter-tag-v1" | question_id | nullifier ) )
```

where `s_q` is the question's **own** independently-random 32-byte linkage secret (ADR-098), minted lazily on the first answer and **destroyed a grace period after the question closes**.

This is the best of both: it is **deterministic** per `(question_id, nullifier)` while the secret lives, so the composite primary key `(question_id, voter_tag)` still enforces one-answer-per-human-per-question at the DB layer and the broker can reproduce a person's tag to revoke a single answer; and it is **unlinkable across questions**, so the same human answering two questions yields two unrelated tags (two unrelated secrets *and* question_ids). The `envelopes` table on its own is therefore no longer a join key for a person's answer history.

**Self-destructing — the liability does not accumulate (ADR-098).** Once `s_q` is destroyed, **no one — not even the broker — can re-derive that question's tags from a nullifier**, so its answers are cryptographically orphaned from every identity, permanently. The re-identification risk is therefore bounded to the *live working set* (open questions plus a short trailing grace + retention window) rather than growing forever behind one global secret. The destruction trigger is a question's own lifecycle (`closes_at` + grace), the finest natural epoch — it subsumes the calendar-epoch rotation once sketched for v2. (Epoch-rotated Self *scopes* — so even the nullifier rotates — remain the deeper, separate v2 change.)

**Wrapped at rest (ADR-098).** `s_q` is stored **encrypted** — `AES-256-GCM(master_key, s_q)`, the master key held in broker env / SSM, never in any database. So forward secrecy comes from *destroying* the wrapped secret (the master key can't decrypt a nulled row), while a DB-only leak *without* the master key yields only ciphertext — restoring the "a dump of the answers data alone can't relink" property even for open questions. The wrapped secrets live in a broker-owned `chorum_secrets` database (the broker has only `USAGE`, not `CREATE`, on the shared schema), co-located on the same RDS instance as the main DB.

**Where linkage now lives.** Re-linking the answers table to individuals requires *all* of: a question's **still-live** `s_q`, the env/SSM **master key** to unwrap it, *and* the `registrations` nullifier list — and is impossible for any question whose secret has been destroyed. Per-person tallies the broker genuinely needs (the §14.2 ask-credit count, the "respondents" stat) are kept as explicit counters on the `registrations` row, not derived by scanning answers. The broker can still link when it must (revoke, on-chain invalidation, gating) **for live questions only**; the bulk data — the thing most likely to be queried, exported, or leaked — carries only per-question pseudonyms.

### 1.5 Verify all, trust none (broker side)
The broker treats every envelope as potentially malicious. Verification is split in two:

- **Once, at registration (`POST /v1/register`, §8.1):** the broker runs the real SNARK check on the Self proof set via the **self-bridge**, **confirms the proof's Merkle root against Self's live on-chain Identity Registry on Celo** (the one and only on-chain read — it proves the proof was built against the real registry, where one-passport→one-identity is enforced), enforces the bindings (agent_key ↔ `userDefinedData`, scope, one shared nullifier), re-derives the bucketed predicates, atomically binds `nullifier ↔ agent_key` in the registry, and issues a **broker-signed DelegationToken**.
- **Per envelope (`POST /v1/envelopes`):** the broker verifies *its own* signature on the DelegationToken, the token's expiry, the registry/revocation status, the agent's per-question signature, the request linkage, and the uniqueness constraint — every time. **No bridge call, no Self proof, no raw passport data** at answer time.

There is no phone signature on the token; registration integrity comes from the SNARK, per-answer integrity from the broker's signature. The frontend never sees raw envelopes; it sees only verified writes.

### 1.6 Coercion resistance (v0 posture)
The skill must never emit a side-channel artifact (signed receipt, plaintext log shipped off-device, screenshot to cloud) that lets a third party prove how the user answered. The user gets a local audit trail. Nobody else does.

**Known residual: voluntary key transfer.** After enrollment, `agent_key` is just an Ed25519 keypair on disk; a user can sell the key file + passphrase + cached DelegationToken and let a briber answer under their `unique_identifier` until the token expires. This is the dominant bribery attack and is **not defended in v0**. The full counter-measure set (hardware-bound keys, phone-held voting authority, periodic re-attestation) is designed in **[v2](ARCHITECTURE_V2.md)**. v0's only mitigation is that there is no money to win — with no payout, there is little to bribe for.

### 1.7 Indistinguishable response fidelity
Chorum will plant honeypot questions to catch lazy agents. The skill must answer real and test questions with identical depth. No "is this a test?" branches — that defeats the mechanism. (Honeypot *enforcement* lands in v2; the principle is fixed now so the skill never grows a test-detection branch.)

### 1.8 Local-first decisioning
All policy evaluation, persona projection, and answer generation runs in-process inside the user's Hermes/OpenClaw instance and model provider.

### 1.9 Idempotent and replay-safe
Networks fail; brokers retry. Every question carries an ID. Answering the same `question_id` twice is a no-op. Every envelope includes a per-question agent signature over `(question_id, answer, nonce, delegation_hash)` so envelopes can't be replayed against a different `question_id`.

### 1.10 Time-boxed
Questions have a validity window. Stale questions are dropped, not answered late.

### 1.11 Memory-provider agnostic
Hermes supports several memory backends. The skill talks through Hermes's memory abstraction; it never imports a specific provider. (v0 hard-codes one provider in practice; the abstraction is wired in a later iteration.)

### 1.12 Override is sacred
The user can preview, edit, or veto any answer before submission. Every submitted answer is revocable post-hoc within the protocol's revocation window.

**v0 cron deployment note.** When the skill runs as the `chorum` plugin driven by a cron job (§7, the production path), answering is *unattended* — there is no live preview between generation and submission. The pre-submission veto is therefore replaced by an opt-in policy gate: nothing is auto-submitted unless the user sets `auto_answer: true` in `policy.yaml`, and the deterministic policy backstop (topic allow/blocklist, daily cap, replay-safety) is re-checked inside `chorum_submit_answer` on every submit. Post-hoc revocation remains the user's recourse.

### 1.13 Phone is the enrollment device, not a hot dependency
The user's phone (running the Self app) is touched at exactly three moments: **install**, **refresh** (every 90 days), and **revocation**. Because age granularity uses a multi-threshold scheme (§8.3), *install* may run several quick Self proofs back-to-back; this cost is paid once. In steady state, the phone is never contacted.

### 1.14 Cheap relevance gating before generation
Most users have no formed view on most questions. If the skill runs a full generation just to discover the user has no signal, the marginal answer costs more than it is worth. So before answering, the agent checks whether the user actually has a view; if not, it emits a `no_signal` envelope and skips generation.

**`no_signal` is first-class data**, not noise — "47% of EU 25–34 respondents had no formed view on synthetic meat" is exactly the silent-majority finding that traditional Likert-forced polls hide. Aggregation treats `no_signal` as its own bucket.

> **v0 realization.** Because answer generation is host-resident (the Hermes/OpenClaw agent reasons over its own memory), the relevance gate is the agent's *own judgement*, not a separate embedding lookup. The `ANSWER_PROMPT` instructs the agent to record `no_signal` (`chorum_submit_no_signal` / CLI `submit-no-signal`) rather than guess. The embedding-tier pre-filter described in §7.3 is the reference design the standalone harness uses; the dedicated opinion-fingerprint optimization is a later iteration.

### 1.15 Reward information that corresponds to a real person, not participation
The eventual marketplace must reward *information that corresponds to a real person*, never mere participation. In v0 there is no reward at all, so this principle shows up only as: **`no_signal` is honored, not penalized** — an honest "no view" is recorded as data rather than pressured into a fabricated opinion. The full pricing model (baseline reimbursement + at-risk grounding bonus) arrives with payments in [v1](ARCHITECTURE_V1.md)/[v2](ARCHITECTURE_V2.md).

---

## 2. v0 system overview

```
┌────────────────────┐        ┌─────────────────────────────┐
│  Asker (browser)   │        │  Curious public (browser)   │
└─────────┬──────────┘        └──────────────┬──────────────┘
          │ POST question                    │ GET question/aggregate
          ▼                                  ▼
┌─────────────────────────────────────────────────────────────┐
│  chorum-web  (Next.js, App Router, server components)       │
│  - reads: questions, aggregates                             │
│  - writes: questions (only, gated by asker unlock §15)      │
└──────────────────────────┬──────────────────────────────────┘
                           │ SQL (read mostly)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Postgres  (shared)                                         │
│  questions │ envelopes │ aggregates │ askers │ registrations │
│  revocations                                                │
└────────────▲──────────────────────────────▲─────────────────┘
             │ write envelopes              │ poll for open questions
             │ increment aggregates         │
┌────────────┴───────┐               ┌──────┴─────────────────┐
│  chorum-broker     │   HTTP/JSON   │  chorum-skill          │
│  (Python/FastAPI)  ├──────────────►│  (Python, in Hermes/   │
│                    │◄──────────────┤   OpenClaw)            │
│  - dispatches Qs   │  envelopes    │  - answers Qs locally  │
│  - verifies        │               │  - stamps DelegationTok│
│    envelopes       │               │  - signs per question  │
└─────────┬──────────┘               └────────────┬───────────┘
          │ SNARK verify (register only)          ▲
          ▼                                       │ install + refresh only
┌────────────────────┐                ┌───────────┴───────────┐
│  self-bridge (Node)│                │  User phone — Self app │
└────────────────────┘                └────────────────────────┘
```

**Boundaries.** The frontend and the broker share a database but not code; they communicate only through Postgres. The broker is the only service that can write `envelopes` rows (enforced by DB role grants). The frontend is the only service that creates `questions`. Agents never talk to the frontend; they only talk to the broker.

**Why three services and not one.** The broker's verification logic is security-critical and must be reviewable in isolation. Keeping it as a separate Python service lets it share verification code with `chorum-skill` and lets us deploy/scale them differently later.

---

## 3. Shared database

Postgres. Schema is owned by `chorum-web` (Drizzle migrations live in that repo) but both services read from it; the broker has its own role with write permission scoped to `envelopes`, `aggregates`, `revocations`, and `registrations`.

```sql
CREATE TABLE askers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name  TEXT NOT NULL,
  unique_identifier TEXT,          -- §15: stamped by the broker after eligibility check; NULL for anonymous/demo asks
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE questions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asker_id    UUID REFERENCES askers(id),
  text        TEXT NOT NULL,
  topic       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  closes_at   TIMESTAMPTZ NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open'   -- 'open' | 'closed'
);

CREATE TABLE envelopes (
  question_id          UUID NOT NULL REFERENCES questions(id),
  unique_identifier    TEXT NOT NULL,              -- §1.4: PER-QUESTION voter tag = HMAC(s_q,
                                                   --   "chorum-voter-tag-v1"|question_id|nullifier), s_q = the question's
                                                   --   own secret (destroyed at close, ADR-098). NOT the raw nullifier —
                                                   --   unlinkable across questions. NEVER write the nullifier here.
  answer               TEXT NOT NULL,              -- LLM-generated answer text (empty string when no_signal=true)
  no_signal            BOOLEAN NOT NULL DEFAULT FALSE, -- §1.14: agent had no relevant memory; skipped generation
  disclosed_predicates JSONB NOT NULL,             -- bucketed {age_band, region, ...} — coarse, shared by many users
  agent_signature      TEXT NOT NULL,              -- base64 Ed25519 (agent_key over the per-question payload)
  delegation_hash      TEXT NOT NULL,              -- hash of the broker-issued DelegationToken used
  submitted_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (question_id, unique_identifier)     -- voter_tag is deterministic per (question, human) → 1 answer per human per question
);

-- Nullifier registry: written once per identity at POST /v1/register (§8.1).
-- Enforces one agent_key per Self nullifier (atomic Sybil bind) and backs
-- the broker-issued session credential (DelegationToken).
CREATE TABLE registrations (
  unique_identifier    TEXT PRIMARY KEY,           -- Self nullifier (scope "chorum-v1") — the ONLY raw-nullifier-keyed table
  agent_key            TEXT NOT NULL,              -- base64 Ed25519 pubkey bound to this nullifier
  disclosed_predicates JSONB NOT NULL,             -- bucketed {age_band, region} re-derived at registration
  issued_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at           TIMESTAMPTZ NOT NULL,       -- credential TTL (default issued_at + 90 days)
  revoked_at           TIMESTAMPTZ,                -- NULL unless revoked
  answer_count         INTEGER NOT NULL DEFAULT 0, -- §1.4/§14.2: per-person answer tally (envelopes can't be grouped per-person)
  signal_count         INTEGER NOT NULL DEFAULT 0  -- of which opinion-bearing (no_signal=false); backs the ask-credit gate
);

CREATE TABLE aggregates (
  question_id            UUID PRIMARY KEY REFERENCES questions(id),
  total_answers          INTEGER NOT NULL DEFAULT 0,   -- grand count, no_signal included
  by_predicate           JSONB NOT NULL DEFAULT '{}',  -- SIGNAL-only option tally per bucket: {"region:EU": {"yes": 30, "no": 12}, ...}
  no_signal_total        INTEGER NOT NULL DEFAULT 0,   -- §1.14: count of no_signal envelopes
  no_signal_by_predicate JSONB NOT NULL DEFAULT '{}',  -- §1.14: no_signal count per bucket
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE revocations (
  delegation_hash TEXT PRIMARY KEY,
  revoked_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON envelopes(question_id);
CREATE INDEX ON envelopes(submitted_at);
```

The composite primary key on `envelopes(question_id, unique_identifier)` is the hard enforcement of Sybil resistance at the database layer. Because `unique_identifier` holds the deterministic per-question voter tag (§1.4), a repeat answer from the same human to the same question collides on the PK and **overrides** the earlier envelope in place rather than ever creating a second one — the broker can crash, restart, double-submit and the DB still holds at most one row (one vote) per human per question — while two answers by the same human to *different* questions store unrelated tags, so the table cannot be grouped back into one person's history. Each question's secret `s_q` that derives the tag lives — **wrapped** under an env/SSM master key — in a broker-owned `chorum_secrets` database (the `question_secrets` table, ADR-098), never in this shared schema, and is destroyed a grace period after the question closes; per-person tallies are kept on `registrations.{answer_count,signal_count}` rather than by scanning `envelopes`.

> **Secrets store (ADR-098).** `question_secrets(question_id, secret, closes_at, destroyed_at)` is **not** part of this shared schema. It lives in a broker-owned `chorum_secrets` database (`CHORUM_BROKER_SECRETS_DATABASE_URL`), co-located on the same RDS instance as the main DB; `chorum_web` / `chorum_classifier` have no access to it. `secret` is the **wrapped** `s_q` (`AES-256-GCM(master_key, s_q)`), so a dump of the instance yields only ciphertext. A periodic reaper destroys (`secret = NULL`) every secret whose question closed more than the grace window ago; once destroyed, the master key can no longer decrypt it, so the question's answers are unlinkable even to the broker.

> **Reserved for later versions.** [v1](ARCHITECTURE_V1.md) adds payout/credential columns + tables; [v2](ARCHITECTURE_V2.md) adds the answer-integrity tables (`memory_commitments`, `fidelity_scores`, `audit_flags`) and a `grounding_commitment` column on `envelopes`. None of these exist or are enforced in v0.

---

## 4. `chorum-web` — frontend

Next.js App Router. Server components for reads; client components only where interactivity demands it.

**Stack.** Next.js 14+ (App Router), TypeScript, Drizzle ORM, Postgres, Tailwind.

**Pages.**
- `/` — list of recent open questions with answer counts. Server component, queries Postgres directly.
- `/ask` — form to create a question. Server action validates, **checks asker eligibility (§15)**, and on success submits and redirects to the question detail page.
- `/q/[id]` — question detail. Shows the question text, total answer count, a breakdown by predicate (e.g. "EU: 42, non-EU: 18"), a **"No formed view" breakdown** (overall + per-group `no_signal` rate, §1.14), and a paginated list of individual answers with their disclosed predicates. Polls every 10s for new envelopes.

**What it does NOT do (v0).**
- No general auth. Askers identify by display name; the right to *ask* is gated by the answer-contribution threshold (§15), proven by presenting a DelegationToken.
- No payments. No payment fields in the UI.
- No envelope writes. The DB role used by Next.js doesn't have `INSERT` on `envelopes` or `aggregates`.
- No direct talking to agents. Everything goes via the database, which the broker writes.

**Layout.**
```
chorum-web/
├── src/app/
│   ├── page.tsx              # /
│   ├── ask/page.tsx          # /ask
│   ├── q/[id]/page.tsx       # /q/[id]
│   └── layout.tsx
├── src/db/{client.ts,schema.ts}
├── src/actions/create-question.ts
└── src/components/{question-card,ask-form,aggregate-chart}.tsx
```

---

## 5. `chorum-broker` — dispatcher and verifier

Python service. Two responsibilities: dispatch open questions to agents, and verify+persist envelopes that come back.

**Stack.** Python 3.11+, FastAPI, asyncpg, pynacl (Ed25519), Pydantic v2.

**HTTP API.**
- `GET /v1/questions/open?since=<iso8601>` — agents poll for new open questions. Returns `[{question_id, text, topic, created_at, closes_at, nonce}]`.
- `POST /v1/register` — agents enroll once at install. Body is the **enrollment bundle** `{self_proofs[], agent_key}` (§8.5). The broker SNARK-verifies the proofs via the self-bridge, binds `nullifier ↔ agent_key`, and returns the broker-issued **DelegationToken** or `{accepted: false, reason}`. Idempotent: re-registering the same `(nullifier, agent_key)` re-issues a fresh token; a *different* agent_key for an already-bound nullifier is rejected (Sybil).
- `POST /v1/envelopes` — agents submit answers (§8.5). Returns `{accepted: true}` or `{accepted: false, reason}`.
- `POST /v1/askers/eligibility` — an asker presents their DelegationToken; the broker authenticates it and returns `{authorized, can_ask, unique_identifier, remaining_*}` (§15.3).
- `GET /healthz` — liveness.

For v0, simple HTTP polling is fine.

**Registration pipeline (once, `POST /v1/register`).** The only path that touches a Self proof.
```
parse enrollment bundle: {self_proofs[], agent_key}
  → for each self_proof: verify real SNARK via the self-bridge (@selfxyz/core)
       (rejects if proof invalid OR timestamp outside Self's ±1 day window)
  → ON-CHAIN REGISTRY CHECK (registration only, one Celo RPC read via the self-bridge):
       confirm each proof's identity-registry Merkle root is a CURRENT/known root
       published by Self's on-chain Identity Registry / Hub on Celo, AND the identity
       is registered. (This is the ONLY on-chain read in the system.)
  → enforce bindings: agent_key == userDefinedData, scope == "chorum-v1",
       all proofs carry the SAME nullifier  → unique_identifier
  → re-derive region (from disclosed nationality) and age_band (from the older-than
       booleans) — the broker's value is authoritative
  → atomic registry bind:
       INSERT registrations(...) — reject if nullifier already bound to a DIFFERENT agent_key
  → issue DelegationToken: broker_signature = Sign(broker_key, H(canonical_json(claims)))
  → return the DelegationToken
```

**Verification pipeline (per envelope, `POST /v1/envelopes`).** No bridge call, no Self proof.
```
parse (pydantic)
  → verify broker_signature on delegation_token using the broker's own pubkey
  → check token.expires_at > now()
  → check registrations[token.unique_identifier] exists, agent_key matches, revoked_at IS NULL
  → recompute expected delegation_hash and compare
  → verify agent_signature over H(question_id, answer, nonce, delegation_hash) using token.agent_key.public
  → check question_id exists, status='open', closes_at > now()
  → check signed predicates are eligible for the question scope
  → ensure (lazily mint, wrapped) this question's secret s_q in chorum_secrets, then
       derive voter_tag = HMAC(s_q, "chorum-voter-tag-v1"|question_id|unique_identifier)  (§1.4, ADR-098)
  → INSERT envelope under voter_tag (composite PK = one row per human; a re-submission
       overrides that row in place; raw nullifier never stored)
  → increment aggregates row for question_id (or rebuild it after an override)
  → bump registrations.{answer_count, signal_count} for the nullifier  (per-person tally; §14.2)
```
All of the last three writes share one transaction, so aggregates, the per-person counters, and the envelope can never drift apart.

If any step fails, the request is rejected with a reason code; nothing is written. Reasons are logged but **not** returned in detail in production (avoid an oracle); v0 returns detailed reasons for debugging.

**Question dispatch.** Broker doesn't push; agents poll `GET /v1/questions/open?since=last_poll`. Each agent tracks its own `last_poll` from the max broker-supplied `created_at` it has seen, not the host wall clock. Restart-safe.

**Layout.**
```
chorum-broker/src/chorum_broker/
├── main.py                   # FastAPI app
├── routes/{questions,register,envelopes,askers}.py
├── verify/
│   ├── self_identity.py      # registration: real SNARK check + bindings + predicate derivation
│   ├── bridge_client.py      # HTTP client for the self-bridge (registration only)
│   ├── credential.py         # issue + verify the broker-signed DelegationToken; broker keypair
│   ├── delegation.py         # per-envelope: token signature + expiry + registry/revocation
│   └── envelope.py           # agent signature + linkage
├── db/{client,queries}.py
├── aggregates.py
├── eligibility.py            # signed-predicate scope checks + asker unlock threshold
└── config.py
```

---

## 6. `chorum-skill` — trust boundaries

```
┌──────────────────────────────────────────────────────────┐
│  chorum-broker (only contact in steady state)            │
└──────────────▲────────────────────┬─────────────────────┘
               │ envelope            │ open-questions poll
┌──────────────┴────────────────────▼─────────────────────┐
│  User device / server — Hermes/OpenClaw runtime          │
│  ┌──────────────────────────────────────────────────┐   │
│  │  chorum skill                                     │   │
│  │  - holds agent_key (Ed25519, on-disk encrypted)   │   │
│  │  - holds cached DelegationToken                   │   │
│  │  - never holds passport material                  │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
                 ▲ rare: install + refresh + revoke
┌────────────────┴───────────────────────────────────────┐
│  User phone — Self app                                  │
└────────────────────────────────────────────────────────┘
```

Three trust boundaries: broker, agent runtime, phone. The phone is touched only at the three enrollment moments. Steady-state traffic flows entirely between the agent and the broker.

---

## 7. `chorum-skill` — layered architecture

**Production path (v0): a Hermes/OpenClaw plugin + cron, not a standalone process.** The skill installs into the user's existing agent (`hermes_agent.plugins` entry point → `plugin.py:register`) and exposes tools under the `chorum` toolset: `chorum_list_open_questions`, `chorum_submit_answer`, and `chorum_submit_no_signal` (`tools.py`). A cron job (`schedule.py`) fires on a schedule; the host agent answers open questions through those tools **using its own configured model and memory**, so there is no second model-provider API key. The privacy-critical work stays deterministic at the tool boundary: the model only sees question text/topic and returns answer text, while policy gating, the delegation token, the nonce, and envelope signing live entirely inside the tools (the model never sees identity material).

Canonical install (prod): `pip install git+...#subdirectory=packages/skill` then `chorum-skill onboard`.

The layered pipeline below describes the in-process Answerer flow, which v0 retains as the **dev/CI harness** (`dev_runner.py` with `FakeLLMClient`, no network LLM) and as the reference for the deterministic layers the tools reuse (Policy, Envelope, Ledger). The Relevance layer (§7.3) short-circuits past Persona and Answerer when the user has no signal.

```
   in → Channel (broker I/O)
         → Policy (gate)
         → Relevance (cheap gate) ──┐ below threshold:
         → Persona (projection)     │ skip Persona+Answerer,
         → Answerer (LLM)           │ emit no_signal envelope
         → Envelope (sign) ◄────────┘
         → Ledger (local SQLite)
         → UI (Hermes channels)
```

### 7.1 Channel — `broker.py`
Polls the broker at `GET /v1/questions/open?since=<last_seen>` (default 30s). Persists `last_seen` from broker-supplied `created_at` so host clock skew cannot skip questions. Submits envelopes. Backoff, retry, replay. No business logic.

### 7.2 Policy — `policy.py`
Pure function `(question, user_policy, ledger_stats) -> Decision` with decisions `answer | decline | prompt_user`. User policy is plain YAML in `~/.hermes/chorum/policy.yaml`: topics, askers, max/day, auto-submit window. Honeypot detection lives elsewhere; policy never branches on "is this a test".

### 7.3 Relevance — `relevance.py` (reference design)
The cheap gate satisfying §1.14. Pure function `(question, memory_handle) -> RelevanceScore ∈ [0,1]`: embed the question (retrieval-tier model), run k-NN against the user's memory through Hermes's abstraction, return a top-k similarity score. Below threshold → short-circuit to a `no_signal` envelope; above → continue to Persona/Answerer with `relevance_score` attached. In the v0 production path this is realized **host-side** (the agent's own judgement), per §1.14.

### 7.4 Persona — `persona.py`
Pure `(question, memory_handle) -> PersonaProjection`. Only runs when Relevance cleared the gate. Output is a **minimal sanitized snapshot** scoped to the question — no raw memory IDs, no source quotes, **no demographic fields** (those live in the DelegationToken). Deterministic-ish.

### 7.5 Answerer — `answerer.py`
Single LLM call `(persona_projection, question, style_guide) -> Answer`. Returns the answer plus a *local-only* rationale for the audit trail (never serialized into the envelope). Does **not** see the DelegationToken or `unique_identifier` — strict identity/inference separation.

### 7.6 Envelope — `envelope.py` + `delegation.py` + `crypto/`
`delegation.py` loads the cached broker-issued DelegationToken from encrypted storage; if expired, it fails the request and triggers a refresh prompt. `envelope.py` builds:
```
{ question_id, answer, no_signal, relevance_score,
  delegation_token, agent_signature, nonce }
```
A `no_signal` envelope is just an envelope with `answer = ""` and `no_signal = true`; the broker verifies it the same way.

### 7.7 Ledger — `ledger.py`
Local SQLite (`questions`, `answers`, `submissions`, `revocations`). PK `question_id`. Records `no_signal` and `relevance_score` for every submission. Encrypted at rest. Read-only views to the UI.

### 7.8 UI — `ui.py`
Uses Hermes's messaging-channel abstraction to prompt the user, send summaries, and **notify when the DelegationToken is about to expire** (7 days out). Telegram only in v0.

---

## 8. Onboarding — the DelegationToken handoff

The only time the phone produces cryptographic material for the agent. Built on **Self**: passport/ID NFC + zk-SNARK, SNARK-verified **off-chain** on the self-bridge (`SelfBackendVerifier`), plus a one-time on-chain Celo Identity-Registry read at registration. Per answer: no chain access.

### 8.0 Why a bridge sidecar
`@selfxyz/core` (verify) and `@selfxyz/qrcode` / `SelfAppBuilder` (request creation) are Node-only; there is no pure-Python verifier. So the Python broker and skill delegate to **`packages/self-bridge`** over HTTP. The bridge does the cryptography; Python keeps every binding/structural check. **Transport note:** the Self mobile app POSTs the proof directly to the `endpoint` configured in the SelfApp — so the self-bridge *is* that endpoint (a callback webhook); the skill polls the bridge for completion.

### 8.1 Flow
1. User installs the `chorum` skill. The skill generates an Ed25519 keypair → `agent_key`.
2. The skill asks the self-bridge `POST /requests {agentKey, profile}`. The bridge builds SelfApp configs via `SelfAppBuilder` with `scope = "chorum-v1"`, `endpoint = <bridge callback>`, `userDefinedData = hex(agent_key)` (the agent-key bind), and disclosures per profile (§8.3). Returns `{requestId, urls[]}` (one QR per threshold proof).
3. The skill renders each `url` as a QR. User opens the **Self app**, taps passport (a **mock passport** in staging — §12), approves. The Self app POSTs the proof to the bridge `endpoint`.
4. The bridge runs `SelfBackendVerifier.verify(...)` per submission. The skill polls `GET /requests/:id` until all expected proofs are `complete`.
5. The skill bundles the verified proofs into an **EnrollmentBundle** and `POST`s to `POST /v1/register`.
6. The broker runs the registration pipeline (§5), atomically binds `nullifier ↔ agent_key`, and returns the **broker-signed DelegationToken** (the session credential replayed per answer). Integrity comes from the broker's signature; the raw `self_proofs` are not stored and never travel again.
7. Skill encrypts and stores the DelegationToken at `~/.hermes/chorum/delegation.token`; the raw `self_proofs` are discarded.

**Graceful degradation.** Only the `18+` proof is required. Finer thresholds are optional; a user who declines extra scans gets `age_band = "18+"` and still participates.

### 8.2 Refresh
7 days before expiry, UI nudges the user. User re-runs the proof set; the skill re-registers; the broker re-verifies and re-issues the token (same nullifier ⇒ idempotent bind). If ignored, the agent stops answering.

### 8.3 Disclosure profiles
Self discloses a single `minimumAge` boolean per proof and the raw nationality. Chorum reconstructs:
- **Region** ← disclosed `nationality` (ISO-3166), mapped to a region and **bucketed by the broker at registration**; raw country discarded after.
- **Age band** ← a **multi-threshold ladder**: at install the skill requests `older-than` proofs at thresholds `[18, 25, 35, 50, 65]`, all under `scope="chorum-v1"` so they share one nullifier. The passing set reconstructs a band. **Exact DOB never disclosed.**

Profiles (picked once on the phone): **Minimal** `{age_band:"18+", region:"EU/non-EU"}`; **Standard** (default) `{5-band ladder, continent}`.

### 8.4 Revocation
Phone publishes a signed revocation to the broker (`POST /v1/revocations` — table ready, live publishing flow lands later). Broker stops accepting envelopes carrying the revoked `delegation_hash`.

### 8.5 Wire formats
**EnrollmentBundle** (`POST /v1/register` input — install only, never stored):
```json
{ "self_proofs": ["<base64 canonical_json({attestationId, proof, publicSignals, userContextData})>"],
  "agent_key": "<base64 32 bytes>" }
```
**DelegationToken** (broker-issued session credential):
```json
{ "version": 2, "scope": "chorum-v1", "unique_identifier": "<Self nullifier>",
  "disclosed_predicates": {"age_band": "35-49", "region": "EU"},
  "agent_key": "<base64 32 bytes>", "issued_at": "...", "expires_at": "...",
  "broker_signature": "<base64 64 bytes>" }
```
`broker_signature = Sign(broker_key, H(canonical_json(token-without-broker_signature)))`. The agent treats the token as opaque.

**Envelope** (`POST /v1/envelopes` input):
```json
{ "question_id": "<uuid>", "answer": "Plain text answer.", "no_signal": false,
  "relevance_score": 0.81, "nonce": "<base64>", "delegation_token": { /* ... */ },
  "agent_signature": "<base64 64 bytes>" }
```
`agent_signature = Sign(agent_key, H(question_id || answer || no_signal || relevance_score || nonce || delegation_hash))`; `delegation_hash = SHA-256(canonical_json(delegation_token))`.

---

## 9. Monorepo layout

```
chorum/
├── ARCHITECTURE_V0.md  ARCHITECTURE_V1.md  ARCHITECTURE_V2.md
├── docker-compose.yml             # postgres + broker + web + self-bridge for local dev
├── packages/
│   ├── web/                       # § 4 — Next.js
│   ├── broker/                    # § 5 — Python/FastAPI
│   ├── skill/                     # § 6-8 — Python Hermes/OpenClaw skill
│   ├── self-bridge/               # Node sidecar — real Self request + verify (@selfxyz/core)
│   └── proto/                     # shared schemas: enrollment, self, delegation, envelope, question
└── scripts/{dev-up.sh, mock-onboard.py}
```

`packages/proto/` holds the canonical JSON schemas. Both `broker` and `skill` validate against them; `web` doesn't need them.

---

## 10. End-to-end lifecycle of one question

```
asker browser → /ask form → server action → asker eligibility check (§15) → INSERT questions
                                                   ▼ Postgres (status='open')
                                          agents poll GET /v1/questions/open?since=…
                                                   ▼ Hermes skill receives Question
                                          Policy → Relevance → Persona → Answerer → Envelope (sign)
                                                   ▼ POST /v1/envelopes
                                          broker.verify pipeline → INSERT envelopes (UNIQUE) + UPDATE aggregates
                                                   ▼ Postgres → frontend revalidates → /q/[id] shows new answer
```

No phone contact anywhere in this lifecycle. The phone was only needed at install and at refresh.

---

## 11. What v0 deliberately skips

Anything stubbed appears in code with `# STUB:` and in each package's README. **No silent stubs.**

- **Payments.** No money flows anywhere in v0. Deferred to **[v1](ARCHITECTURE_V1.md)**. No payment fields in the schema.
- **Public payout credential.** v0 answering uses only the private Chorum-scoped nullifier + DelegationToken. The opt-in public Self Agent ID / ERC-8004 credential needed for withdrawable payouts arrives in **[v1](ARCHITECTURE_V1.md)**.
- **Answer-integrity enforcement.** Grounding commitments, honeypot adjudication, the override-oracle fidelity scoring, bonus escrow/clawback, fidelity-weighted aggregation — all designed for **[v2](ARCHITECTURE_V2.md)**, none enforced in v0. v0's anti-cheat is structural: no reward means little to farm, and the signal-bearing floor (§15) blocks the cheapest ask-farming.
- **Advanced bribery defenses.** Hardware-bound keys, phone-held MACI voting authority, periodic re-attestation — designed for **[v2](ARCHITECTURE_V2.md)** (§1.6).
- **Memory provider abstraction.** Skill hard-codes one provider; the abstraction is wired in a later iteration.
- **Multi-channel skill UI.** Telegram only.
- **Live revocation propagation.** Broker has the `revocations` table; skill respects expiry; live publishing flow lands later.
- **Real-time frontend.** Detail page polls every 10s; WebSocket/SSE later.
- **Lost-phone recovery.** Re-enroll from a fresh install.

### What is DONE in v0
- **Real Self proof verification, verify-once.** `POST /v1/register` runs `SelfBackendVerifier.verify()` through the self-bridge, enforces bindings, derives `region`/`age_band`, atomically binds `nullifier ↔ agent_key`, and issues a broker-signed DelegationToken. Per envelope, only the token signature + registry/revocation are checked — no Self proof at answer time. Plus the one-time on-chain Celo Identity-Registry root read (§5). Mock-passport proofs verify only with `SELF_MOCK_PASSPORT=1` (staging / Celo Sepolia).
- **`no_signal` end to end.** The agent emits `no_signal` (`chorum_submit_no_signal`) instead of guessing; the broker keeps dedicated `aggregates.no_signal_total` + `no_signal_by_predicate` (no-signal envelopes never pollute per-option tallies); the result page renders a "No formed view" breakdown.
- **Asker unlock threshold (§15.3).** Possession-of-DelegationToken auth + the ≥50 answers / ≥10 signal-bearing gate, with admin override.
- **Unlinkable answers at rest, self-destructing (§1.4, ADR-098).** Envelopes are stored under a per-question voter tag (`HMAC(s_q, …|question_id|nullifier)`), never the raw nullifier, so the answers table cannot be grouped into one person's history. Each question has its **own** secret `s_q`, stored wrapped under an env/SSM master key in a broker-owned `chorum_secrets` DB and **destroyed a grace period after the question closes** — after which that question's answers are unlinkable even to the broker, so the liability stays bounded to the live working set instead of accumulating forever. Per-person tallies live as counters on `registrations`; the startup check refuses to boot in production with the dev master key. Verified end to end (the answers table holds no raw nullifier; one person's two answers carry unrelated tags; `s_q` is ciphertext at rest; revoke/invalidation roll the counters back; destroying a closed question's secret orphans its answers while leaving the published aggregate intact).

- **No free-form answer text at rest (#137).** The published page already shows only aggregates, never individual answers — but the answers table itself must not become a re-identification surface either. So the broker persists into `envelopes.answer` **only the canonical option label** it classifies the answer to (or `""` for a no_signal envelope), never the raw string it received. The honest skill already collapses the answer to a single option *before signing* (skill `match_option`), but the broker does not trust that: a tampered/injected client could append re-identifying prose that still classifies to an option ("yes — she runs prod from the Frankfurt box"), or set `no_signal=true` and stash text in `answer`; the broker drops both. The consequence is that even without column-level encryption-at-rest, a DB / backup leak of `envelopes` exposes no free-form micro-data ("a nurse in Lyon with two kids…") that — combined with `disclosed_predicates` + `submitted_at` — could single out a person in a small cohort. The answer column now carries exactly the information the aggregate already publishes (which option), and nothing more. Verified end to end (a signed leaky answer is stored as just `"yes"`; a no_signal envelope stores `""`).

**Residual caveats (carried into IDENTITY.md):** (a) a Celo-side revocation made *after* registration is not re-checked per answer (Chorum's own `registrations` registry governs revocation thereafter); (b) one human holding multiple legal passports yields multiple nullifiers.

---

## 12. Testing posture

Each package has its own suite; one cross-cutting end-to-end suite at the repo root.

**web** — `createQuestion` happy path + validation + eligibility block; detail page renders aggregates without exposing raw envelopes.

**broker (highest-stakes suite)** —
- **Registration** — happy path issues a token; ZK failures (proof-invalid, expired/`InvalidTimestamp`, binding mismatch, differing nullifiers) rejected; **Sybil bind** (second registration of same nullifier with different agent_key rejected; same agent_key re-issues). Bridge mocked in unit tests; live `SELF_MOCK_PASSPORT=1` verify is opt-in.
- **Predicate derivation** — `country → region` and `older-than-booleans → age_band` are pure functions; table-driven over boundary ages, unmapped countries, partial threshold sets → graceful `18+`.
- **Credential** — round-trip sign/verify; any tampered claim fails; non-broker key rejected.
- **Verify envelope** — happy path + expired token, revoked/unknown registration, bad agent signature, swapped `question_id`/`answer`/`nonce`/`delegation_hash` each reject. A signal answer that matches none of the question's options rejects (`answer_unclassified`) before INSERT, so `total_answers` can't outrun the per-option bucket sums; `no_signal` envelopes skip that gate. **No bridge call** on this path (asserted).
- **Uniqueness** — two envelopes from the same `unique_identifier` for the same `question_id` → second rejects via DB constraint (real Postgres in CI).
- **Aggregate increment** — accepted envelopes update `total_answers`/`by_predicate` without scanning all prior envelopes; `no_signal` lands in its own buckets.
- **Asker eligibility** — token possession authenticated on the envelope trust path; below-threshold asks blocked, admin override allowed.

**skill** — Policy/Ledger pure tests; delegation lifecycle (load, expiry, signature, refresh); envelope signing property tests; persona snapshot tests; Answerer with recorded LLM responses (never live in CI); **identity/inference separation** (Answerer test double never sees DelegationToken or `unique_identifier`); **no phone contact in steady state** across 100 simulated answers.

**end-to-end (`/scripts/e2e.sh`)** — spin up postgres + broker + web + self-bridge + a skill; onboard via mock passport or replayed fixture (`mock-onboard.py`); asker posts a question; mock skill polls, answers, submits; assert envelope in DB, aggregate updated, detail page renders it. **No-bridge-at-answer-time assertion** (bridge hit during `/v1/register`, zero during `/v1/envelopes`). **Boundary-leakage assertion**: scrape the `/v1/envelopes` body; assert it contains exactly `{question_id, answer, no_signal, relevance_score, nonce, delegation_token, agent_signature}` and that `delegation_token` carries **no** `self_proofs`.

---

## 13. v0 open questions

- **Question dispatch transport.** Polling every 30s means ~30s latency; move to SSE/WebSocket later.
- **Broker signing-key management.** The DelegationToken is only as trustworthy as `broker_key`. Where it lives (KMS/HSM/env) and how it rotates (overlap window or forced re-registration) is open. v0: single key in config.
- **Linkage-secret management (§1.4, ADR-098) — resolved.** Each question's secret `s_q` is stored wrapped (AES-256-GCM under an env/SSM master key) in a broker-owned `chorum_secrets` DB co-located on the main RDS instance, and destroyed a grace period after the question closes (a reaper keyed on `closes_at`). Accepted consequence: revoke / Self-invalidation reach only **live** questions — once `s_q` is destroyed a closed question's answers can no longer be located (their aggregate is already published, so this is correct). Open knobs: the grace window length (and the master key must stay stable, since rotating it orphans live wrapped secrets); and whether to ever move the secrets off RDS to KMS/Secrets-Manager for a stronger real-deletion guarantee (ADR-098 Alternatives).
- **Credential-vs-registry revocation latency.** Revocation flips `registrations.revoked_at`, checked per envelope — immediate, but a stolen token works until then (or until `expires_at`). Shortening TTL trades refresh friction for a tighter window.
- **DelegationToken storage at rest.** OS keychain, passphrase-encrypted file, or Hermes-identity-derived key?
- **Aggregate semantics for free-form answers.** v0 aggregates by predicate only; semantic clustering of answer text is a later design and must not leak identifying patterns.
- **Host compromise mid-session.** Attacker with `agent_key` + token can submit until revoked/expired; per-`unique_identifier` rate-limit is the v0 bound.
- **Memory provider query richness.** Does the abstraction expose enough for topic-scoped retrieval?
- **Auto-submit window default.** 0 (always prompt) or non-zero (trust the policy)?

---

## 14. Asker gating — earning the right to ask (v0 form)

**Problem.** Posting a question imposes cost on everyone else: a dispatched question fans out to answering agents, each spending its own inference. An unrestricted ask is a negative externality. v0 has no payments, and we deliberately do **not** gate on a third-party identity (X login) or asker-side Self verification — the first leaks the question and ties growth to a platform we don't control; the second adds demand-side friction. We need a gate that is intrinsic, self-limiting without money, and forward-compatible with payments.

### 14.1 Fan-out cap — the cost ceiling
A question does not need every onboarded agent to answer it. The broker samples a bounded subset of eligible agents per question (sized for the target confidence, not the whole population). This caps inference cost *per question* regardless of who asks. (Sampling is statistically fine — a few hundred to a few thousand responses gives tight bands; publish the realized N.)

### 14.2 The v0 unlock threshold
v0 does not need a continuous credit ledger on day one. It starts with a **boolean unlock**:
- **Unlock to ask:** an agent may post questions once it has submitted **≥ 50 answers total, of which ≥ 10 are signal-bearing** (`no_signal = false`). The total threshold bootstraps coverage; the signal-bearing floor is the anti-farming clause — it stops an agent grinding pure `no_signal` envelopes (the cheap branch) just to buy ask-rights.
- **Admin override:** admins and designated seed accounts can post beyond any threshold. This is the bootstrap valve — the network needs questions in circulation before there is a body of answerers to earn against.

**Asker auth (implemented).** The threshold attaches to an *identity*, so the asker proves one by presenting their broker-signed DelegationToken to `POST /v1/askers/eligibility`. The broker authenticates it on the *same trust path as an envelope* (broker signature valid, unexpired, backed by a live non-revoked registration). It returns `{authorized, can_ask, unique_identifier, remaining_*}`. The web `/ask` action calls it after validation and blocks unless `can_ask`, then stamps the verified `unique_identifier` on the `askers` row (never from user input). Config: `ASKER_UNLOCK_TOTAL_ANSWERS` (50), `ASKER_UNLOCK_SIGNAL_ANSWERS` (10), `ASKER_ADMIN_IDENTIFIERS`, `ASKER_AUTH_REQUIRED` (default on; off for local demos).

*v0 limitation (deliberate):* asker auth is **possession** of a live, broker-signed credential, not yet **proof-of-private-key** — a stolen-but-unexpired token authenticates. Hardening (per-request challenge or a signature over the question payload, mirroring the envelope `agent_signature`) is deferred; the downside is bounded because a thief can only spend the victim's *own* answer credits.

### 14.3 Where this is heading
The boolean unlock is the v0 form of a general **answer-credit economy**: earn credits by answering, spend credits by asking, with credits conserving (the network can never be asked for more answers than it has supplied). **[v1](ARCHITECTURE_V1.md)** generalizes this to a continuous ledger and adds a *buy-credits-with-money* path for demand-side customers who will never run answering agents. **[v2](ARCHITECTURE_V2.md)** makes earned credit fidelity-weighted so confabulated answers can't be laundered into ask-rights.

### 14.4 X-sharing is a growth boost, not a gate
A generic "I use Chorum" promo on X is free, on-message advertising and (being generic) preserves question anonymity. But X accounts are cheap and X ≠ proof-of-personhood, so it is a **weak** spam gate. It is therefore optional and incentivized (a share can grant a small credit bonus or reach boost), never the toll. Distribution and gating stay decoupled.
