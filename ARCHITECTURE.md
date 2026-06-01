# Hearme — v0 Architecture

Three components wired together:
1. **`hearme-web`** — Next.js site where askers post questions and anyone can see how agents answered.
2. **`hearme-broker`** — Python service that dispatches questions to agents, verifies returned envelopes, and is the only writer to the answers table.
3. **`hearme-skill`** — Python skill that runs inside a user's Hermes Agent and answers questions on their behalf.

Plus a shared Postgres database, and the user's phone (running the **Self** app, [self.xyz](https://self.xyz)) which appears only at install/refresh time.

> **Identity provider: Self (self.xyz).** Hearme's proof-of-personhood layer is built on Self — passport/national-ID NFC + zk-SNARKs. Proofs are SNARK-verified **off-chain** on our own backend; the **only** on-chain dependency is a single Celo Identity-Registry read **at registration** (§5, Sybil hardening). Per answer there is **no chain access and no proof at all** (§1.5). This replaced an earlier zkPassport integration; see `IDENTITY.md` for the why and §8 for the concrete flow.

## 1. Design principles

These are the non-negotiables. Every component below exists to serve one of them.

### 1.1 Consent is the product
The agent answers *on behalf of* the user. If users ever feel surveilled, Hearme dies. The skill must expose a sharp, legible policy surface (topics, askers, daily caps, payment floor) and never silently drift from it. Default to off; opt-in per category.

### 1.2 Personal-data minimization at the boundary
The agent reasons over rich personal memory locally (or with help of a model provider). Only the **answer itself** plus the user's **DelegationToken** — a **broker-issued, broker-signed session credential** carrying a stable `uniqueIdentifier`, the bucketed predicates, and the bound `agent_key` — crosses the device + model boundary. Raw facts, chain-of-thought, source memories, raw passport fields, and the raw Self proofs — never.

> **Why a broker-issued credential (not the raw proof).** Self proofs expire **±1 day** (`SelfBackendVerifier` throws `InvalidTimestamp` outside that window), so the broker *cannot* re-verify a stored proof per envelope over a 90-day token. Hearme therefore **verifies the Self proofs exactly once, at registration** (§8.1), and the broker issues a signed session credential the agent replays per answer (§5). This is not just a performance choice — it is forced by Self's freshness window. It also closes the data-minimization boundary: the raw proof (and the raw nationality inside it) reaches the broker **once at registration**, where it is bucketed (`region`, `age_band`) and the raw form discarded; per-answer, only the bucketed credential travels.

#### 1.2.1 ChatGPT export memory sidewheel

Some users will have the richest self-history in ChatGPT rather than Hermes.
Hearme may therefore offer an optional sidewheel: the user explicitly downloads
their ChatGPT data export, and a local CLI imports `conversations.json` into a
Hearme-owned SQLite FTS database under the same local root as the ledger. The
skill can then select that database as a `MemoryProvider`.

This sidewheel is **not** app scraping. It must not read private ChatGPT macOS
app containers, use Accessibility to scrape the UI, or assume OpenAI exposes a
local chat-history API. It is export/import only, initiated by the user. The
imported DB is local, deletable, and separate from the broker. The provider
still returns a question-scoped `MemorySnapshot`; raw conversation IDs and
source metadata do not leave the memory layer, and nothing from the export is
sent to the broker.

### 1.3 Predicate disclosure, fixed at install
Demographic disclosure is decided **once**, at install, when the user picks a disclosure level on the phone (e.g. age band, region). The chosen predicates are proven via Self, verified once by the broker at registration, and baked into the broker-issued DelegationToken. Every answer reuses the same predicate set; askers do **not** negotiate predicates per question. If an asker needs finer slicing, they slice post-hoc on the aggregate, not by demanding new disclosures from the user.

### 1.4 Sybil resistance via stable scoped uniqueness; linkability is bounded and named
The DelegationToken's `uniqueIdentifier` is the **Self nullifier** under the single scope `"hearme-v1"` (Self collapses domain + scope into one ≤31-ASCII scope string; the nullifier is `unique-per-user-per-scope`) — so the same passport produces the same identifier across every Hearme answer. The broker uses this for one-answer-per-`(question_id, uniqueIdentifier)` enforcement and for per-user honeypot scoring. This means **the broker can link a user's answers to each other** within Hearme. This is a deliberate v0 tradeoff: it buys "zero time cost per question" (no phone round-trip), and the broker is contractually bound to publish only aggregates. Epoch-rotated scopes (so identifiers rotate weekly/monthly) are a v0.2 upgrade documented in §13.

### 1.5 Verify all, trust none (broker side)
The broker treats every envelope as potentially malicious. Verification is split in two:

- **Once, at registration (`POST /v1/register`, §8.1):** the broker runs the real SNARK check on the Self proof set via the **self-bridge**, **confirms the proof's Merkle root against Self's live on-chain Identity Registry on Celo** (the one and only on-chain read — see §5; it proves the proof was built against the real registry, where one-passport→one-identity is enforced), enforces the bindings (agent_key ↔ `userDefinedData`, scope, one shared nullifier), re-derives the bucketed predicates, atomically binds `nullifier ↔ agent_key` in the registry, and issues a **broker-signed DelegationToken**.
- **Per envelope (`POST /v1/envelopes`):** the broker verifies *its own* signature on the DelegationToken, the token's expiry, the registry/revocation status, the agent's per-question signature, the request linkage, and the uniqueness constraint — every time. **No bridge call, no Self proof, no raw passport data** at answer time.

There is no phone signature on the token; registration integrity comes from the SNARK, per-answer integrity from the broker's signature. The frontend never sees raw envelopes; it sees only verified writes.

### 1.6 Coercion resistance
The skill must never emit a side-channel artifact (signed receipt, plaintext log shipped off-device, screenshot to cloud) that lets a third party prove how the user answered. The user gets a local audit trail. Nobody else does.

**Residual: voluntary key transfer is the dominant bribery attack.** VISION §7's MACI defeats *per-vote* bribery — a coerced user can claim to have voted any way they like and the briber has no way to verify, so the contract "I'll pay you $X per pro-Y vote" is unenforceable. MACI does **not** defeat **agent-key handover**: after enrollment, `agent_key` is just an Ed25519 keypair on disk under a passphrase the user holds, and the user can sell the key file + passphrase + cached DelegationToken in a single off-platform transaction. The briber then runs the answering bot themselves under that `unique_identifier` for the remaining DelegationToken validity (default 90 days, §8.1). There is no ongoing user cooperation, and MACI is structurally irrelevant because **the briber is the agent**. This is qualitatively cheaper than "install a politically-biased plugin" — there is nothing to install, maintain, or pretend about. It is the dominant bribery attack against v0 and is **not currently defended**. The two defenses, both designed but unbuilt (see §13):

- **Hardware-bound non-exportable signing keys.** `agent_key` is generated inside, and never leaves, a hardware key store: Secure Enclave (macOS/iOS), TPM 2.0 (Windows/Linux desktop), StrongBox (Android), WebAuthn passkey (browser-resident), or cloud HSM with remote attestation (managed Hermes). The skill's `crypto/` module holds *handles*, not bytes; signing an envelope becomes a hardware call. Selling the identity then requires shipping the device. `POST /v1/register` must accept a hardware attestation alongside the pubkey so the broker can record the storage class in `registrations` and gate higher trust tiers on enclave-bound keys.
- **v1 phone-held voting authority for protected questions.** For bribery-sensitive civic questions, the Hermes agent should draft answers but should not hold the final voting authority. A small Hearme phone app can create the MACI/voting key inside Secure Enclave (iOS) or StrongBox (Android), bind that public key to the Self nullifier at registration, and use it to sign off the agent's prepared answer batches. In that model, MACI becomes enforceable again: the briber cannot buy a one-shot key file and run the agent forever; they need ongoing cooperation from the user's identity device, while still lacking a receipt that proves how the user ultimately voted. This raises bribery cost by several degrees and turns "send me your key" into "keep collaborating with me through your phone without being able to prove the result."
- **Bonded withdrawal authority as an anti-sharing incentive.** The same phone-held authority can also control withdrawals from the user's accrued/escrowed Hearme earnings (§14.8), or from an optional user-chosen security bond. This gives the user a direct reason not to share signing access: a briber who can command the key well enough to control answers can also drain or slash the value bound to that key. Prefer bonded earnings over mandatory upfront collateral — a required cash deposit would violate the "you get paid; you do not pay to play" access promise — but tying withdrawal authority to the enclave key turns key sharing into an obvious personal financial risk.
- **Coercion-resistant default client.** The standard phone client for protected questions must make externally observable behavior compatible with multiple final MACI states. A coerced user can appear to comply with a briber's requested action while the final encrypted MACI command is privately revised or superseded. The client must never export a receipt of the final command, and local UI/logs/screenshots must not prove which MACI state won. Reliable bribery then requires more than finding users willing to take money: the attacker must identify users who are genuinely bribeable, willing to run non-standard coercive software or submit to supervised device control, and unable to defect through the standard override path. That is a much harder, less scalable attack than buying a transferable key.
- **Periodic phone re-attestation.** Hardware-binding alone is necessary but not sufficient — a sophisticated briber can rent or buy the device. Every N answers (~200) or M days (~14), the broker issues a challenge that only the user's phone (Self app) can satisfy; the skill suspends answering until it clears. This forces *ongoing* user cooperation and at that point MACI's per-vote unverifiability bites the renewed contract. It is a deliberate, quantitative softening of §1.13's "phone is not a hot dependency" — from ~3 touches/year to ~1 touch every two weeks — accepted in exchange for closing the key-handover hole.

Implementation cost is real: per-platform native bindings (Hermes is Python; hardware-key APIs are native), a fallback policy for hosts without hardware key stores (older Linux servers, generic VMs), and broker-side attestation handling. Until both ship, the v0 posture is to acknowledge this attack explicitly and rely on §14.8's volume cap + minimal per-answer reward to bound the prize a briber can buy.

### 1.7 Indistinguishable response fidelity
Hearme plants honeypot questions to catch lazy agents. The skill must answer real and test questions with identical depth. No "is this a test?" branches — that defeats the mechanism.

### 1.8 Local-first decisioning
All policy evaluation, persona projection, and answer generation runs in-process inside the user's Hermes instance and model provider.

### 1.9 Idempotent and replay-safe
Networks fail; brokers retry. Every question carries an ID. Answering the same `question_id` twice is a no-op. Every envelope includes a per-question agent signature over `(question_id, answer, nonce, delegation_hash)` so envelopes can't be replayed against a different `question_id`.

### 1.10 Time-boxed
Questions have a validity window. Stale questions are dropped, not answered late.

### 1.11 Memory-provider agnostic
Hermes supports 8 memory backends. The skill talks through Hermes's memory abstraction; it never imports a specific provider.

### 1.12 Override is sacred
The user can preview, edit, or veto any answer before submission. Every submitted answer is revocable post-hoc within the protocol's revocation window.

**v0 cron deployment note.** When the skill runs as the `hearme` Hermes plugin driven by a cron job (§7, the production path), answering is *unattended* — there is no live preview between generation and submission. The pre-submission veto is therefore replaced by an opt-in policy gate: nothing is auto-submitted unless the user sets `auto_answer: true` in `policy.yaml`, and the deterministic policy backstop (topic allow/blocklist, daily cap, replay-safety) is re-checked inside `hearme_submit_answer` on every submit. Post-hoc revocation (above) remains the user's recourse. A future channel-notification mode can restore the live veto for users who want it.

### 1.13 Phone is the enrollment device, not a hot dependency
The user's phone (running the Self app) is touched at exactly three moments: **install**, **refresh** (every 90 days), and **revocation**. Because age granularity uses a multi-threshold scheme (§8.3), *install* may run several quick Self proofs back-to-back; this cost is paid once and isolated to these three moments. In steady state, the phone is never contacted.

### 1.14 Cheap relevance gating before generation

**Problem.** Most users have no formed view on most questions. The economics in VISION.md set the per-response payout at roughly the cost of one LLM inference (~a fraction of a cent). If the skill runs a full generation just to discover the user has no signal on a topic, the marginal answer is worth less than its inference cost — the platform burns budget producing noise and the buyer pays for it. At scale, this inverts the unit economics of the whole marketplace.

**Strategy.** The cost of an answer is not a single number. A retrieval-tier embedding lookup over the user's memory is roughly **100–1000× cheaper** than a generation-tier LLM call. The skill MUST exploit this asymmetry: before invoking the Answerer, run a cheap relevance check (§7.3). If the user has no relevant memory above threshold, emit a `no_signal` envelope and skip generation entirely. The no-signal branch drops from ~$0.001 (full inference) to ~$0.00001 (one embedding lookup).

**Implication.** `no_signal` is not noise — it is real aggregate data ("47% of EU 25–34 respondents had no formed view on synthetic meat") and it is exactly the silent-majority finding that traditional Likert-forced polls hide. Aggregation MUST treat `no_signal` as a first-class bucket, not a discarded row.

**The cheap gate creates an incentive problem the gate itself cannot solve.** Once answering pays more than `no_signal`, an agent with *no* genuine signal is paid to confabulate — run a real generation and emit a fluent, plausible answer that is pure model prior rather than the user's view. Such an answer passes any honeypot that only checks "did you run inference," because it did. Naively pricing `no_signal` below a real answer therefore *selects for* confabulation and quietly turns the aggregate into "what the median model thinks humanity thinks." Two earlier framings in this doc were wrong and are corrected in §14: (a) that under-paying `no_signal` is the anti-cheat — it is the opposite; the fix is to make answering's *extra* pay conditional on grounding (§1.15, §14.2); and (b) that a hidden-instruction honeypot is "detectable at the retrieval tier" — it is not; an honest agent that short-circuits at retrieval never sees the instruction, so honeypots must be matched to the claim (§14.6). The full incentive design — grounded-information pricing, memory-commitment grounding proofs, the override oracle, and matched honeypots — is §14.

### 1.15 Pay for grounded information, not participation
The marketplace must reward *information that corresponds to a real person*, never mere participation. **Baseline** payout only reimburses the work actually done: a retrieval-tier `no_signal` and a generation-tier answer are each paid roughly their own cost, so neither branch is profit. All *profit* comes from a **grounding bonus** that only a genuinely grounded answer can keep — it is escrowed and released only if the answer survives audit (§14.3) and the override window (§14.5), and clawed back otherwise. Under this rule honesty is the dominant strategy in every state of the world: answer truthfully when you have signal, emit `no_signal` when you don't (§14.2). Corollary: `no_signal` paying less in absolute terms is *not* a penalty, because answering's extra pay is a bonus-at-risk, not guaranteed money a confabulator can capture.

---

## 2. v0 system overview

```
┌────────────────────┐        ┌─────────────────────────────┐
│  Asker (browser)   │        │  Curious public (browser)   │
└─────────┬──────────┘        └──────────────┬──────────────┘
          │ POST question                    │ GET question/aggregate
          │                                  │
          ▼                                  ▼
┌─────────────────────────────────────────────────────────────┐
│  hearme-web  (Next.js, App Router, server components)       │
│  - reads: questions, aggregates                             │
│  - writes: questions (only)                                 │
└──────────────────────────┬──────────────────────────────────┘
                           │ SQL (read mostly)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  Postgres  (shared)                                         │
│  questions │ envelopes │ aggregates │ askers │ revocations  │
└────────────▲──────────────────────────────▲─────────────────┘
             │ write envelopes              │ poll for open questions
             │ increment aggregates         │
┌────────────┴───────┐               ┌──────┴─────────────────┐
│  hearme-broker     │   HTTP/JSON   │  hearme-skill          │
│  (Python/FastAPI)  ├──────────────►│  (Python, in Hermes)   │
│                    │◄──────────────┤                        │
│  - dispatches Qs   │  envelopes    │  - answers Qs locally  │
│  - verifies        │               │  - stamps DelegationTok│
│    envelopes       │               │  - signs per question  │
└────────────────────┘               └────────────┬───────────┘
                                                  ▲
                                                  │ install + refresh only
                                                  │
                                     ┌────────────┴───────────┐
                                     │  User phone — Self app │
                                     └────────────────────────┘
```

**Boundaries.** The frontend and the broker share a database but not code; they communicate only through Postgres. The broker is the only service that can write `envelopes` rows (enforced by DB role grants). The frontend is the only service that creates `questions`. Agents never talk to the frontend; they only talk to the broker.

**Why three services and not one.** The broker's verification logic is security-critical and must be reviewable in isolation. Bundling it into Next.js API routes would tangle it with UI concerns. Keeping it as a separate Python service lets it share verification code with `hearme-skill` and lets us deploy/scale them differently later.

---

## 3. Shared database

Postgres. Schema is owned by `hearme-web` (Drizzle migrations live in that repo) but both services read from it; the broker has its own role with write permission scoped to `envelopes`, `aggregates`, `revocations`, `registrations`, and the answer-integrity tables `memory_commitments`, `fidelity_scores`, `payout_entitlements`, `audit_flags` (§14).

```sql
CREATE TABLE askers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name  TEXT NOT NULL,
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
  unique_identifier    TEXT NOT NULL,              -- from DelegationToken, stable per user
  answer               TEXT NOT NULL,              -- LLM-generated answer text (empty string when no_signal=true)
  no_signal            BOOLEAN NOT NULL DEFAULT FALSE, -- §1.14 / §7.3: agent had no relevant memory; skipped generation
  relevance_score      REAL NOT NULL,              -- §7.3: top-k embedding similarity vs user memory, in [0, 1]
  disclosed_predicates JSONB NOT NULL,             -- {age_band, region, ...}
  agent_signature      TEXT NOT NULL,              -- base64 Ed25519 (agent_key over the per-question payload)
  delegation_hash      TEXT NOT NULL,              -- hash of the broker-issued DelegationToken used
  grounding_commitment TEXT,                       -- §14.3: refs the memory_commitments root this answer grounds in; NULL when no_signal=true
  submitted_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (question_id, unique_identifier)     -- 1 answer per human per question
);

-- Nullifier registry: written once per identity at POST /v1/register (§8.1).
-- Enforces one agent_key per Self nullifier (atomic Sybil bind) and backs
-- the broker-issued session credential (DelegationToken).
CREATE TABLE registrations (
  unique_identifier    TEXT PRIMARY KEY,           -- Self nullifier (scope "hearme-v1")
  agent_key            TEXT NOT NULL,              -- base64 Ed25519 pubkey bound to this nullifier
  disclosed_predicates JSONB NOT NULL,             -- bucketed {age_band, region} re-derived at registration
  issued_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at           TIMESTAMPTZ NOT NULL,       -- credential TTL (default issued_at + 90 days)
  revoked_at           TIMESTAMPTZ                 -- NULL unless revoked
);

CREATE TABLE aggregates (
  question_id    UUID PRIMARY KEY REFERENCES questions(id),
  total_answers  INTEGER NOT NULL DEFAULT 0,
  by_predicate   JSONB NOT NULL DEFAULT '{}',       -- yes/no tally per bucket: {"region:EU": {"yes": 30, "no": 12}, ...}
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE revocations (
  delegation_hash TEXT PRIMARY KEY,
  revoked_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- §14.3: periodic agent commitment to its WHOLE local memory. The agent posts
-- only the Merkle ROOT (reveals nothing); the broker assigns + co-signs a
-- timestamp. An answer may only ground in a snapshot whose anchor PRE-DATES the
-- question's created_at, so evidence cannot be fabricated after the question is
-- known (§14.3).
CREATE TABLE memory_commitments (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  unique_identifier  TEXT NOT NULL,               -- whose snapshot (Self nullifier)
  merkle_root        TEXT NOT NULL,               -- root over canonical memory leaves
  leaf_count         INTEGER NOT NULL,            -- corpus-size hint (may be padded)
  anchored_at        TIMESTAMPTZ NOT NULL DEFAULT now(),  -- broker-assigned timestamp
  broker_signature   TEXT NOT NULL                -- Sign(broker_key, H(merkle_root || unique_identifier || anchored_at))
);
CREATE INDEX ON memory_commitments(unique_identifier, anchored_at);

-- §14.5: per-identity faithfulness, fed by user overrides (§1.12). Drives the
-- grounding-bonus multiplier, the audit rate, and read-side weighting (§14.7).
CREATE TABLE fidelity_scores (
  unique_identifier  TEXT PRIMARY KEY,
  score              REAL NOT NULL DEFAULT 1.0,   -- smoothed 1 − relevance-weighted override rate
  n_observations     INTEGER NOT NULL DEFAULT 0,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- §14.2: payout entitlement ledger. Records the rule before money flows (§11).
-- Bonus rows sit 'escrowed' until they survive audit + the override window,
-- then 'released'; a failed audit or override flips them to 'clawed'.
CREATE TABLE payout_entitlements (
  question_id        UUID NOT NULL REFERENCES questions(id),
  unique_identifier  TEXT NOT NULL,
  baseline           NUMERIC NOT NULL DEFAULT 0,  -- tier-matched cost reimbursement
  bonus              NUMERIC NOT NULL DEFAULT 0,  -- grounding bonus, at-risk
  status             TEXT NOT NULL DEFAULT 'escrowed', -- 'escrowed' | 'released' | 'clawed'
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (question_id, unique_identifier)
);

-- §14.3/§14.6: answers flagged for grounding audit (random, escalating with
-- relevance_score, stake, and inverse fidelity) or for honeypot adjudication.
CREATE TABLE audit_flags (
  question_id        UUID NOT NULL REFERENCES questions(id),
  unique_identifier  TEXT NOT NULL,
  kind               TEXT NOT NULL,               -- 'grounding' | 'honeypot'
  status             TEXT NOT NULL DEFAULT 'open', -- 'open' | 'passed' | 'failed'
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (question_id, unique_identifier, kind)
);

CREATE INDEX ON envelopes(question_id);
CREATE INDEX ON envelopes(submitted_at);
```

The composite primary key on `envelopes(question_id, unique_identifier)` is the hard enforcement of Sybil resistance at the database layer. The broker can crash, restart, double-submit — the DB still rejects duplicates.

---

## 4. `hearme-web` — frontend

Next.js App Router. Server components for reads; client components only where interactivity demands it.

**Stack.**
- Next.js 14+ (App Router)
- TypeScript
- Drizzle ORM
- Postgres
- Tailwind for styling

**Pages.**
- `/` — list of recent open questions with answer counts. Server component, queries Postgres directly.
- `/ask` — form to create a question. Server action submits and redirects to the question detail page.
- `/q/[id]` — question detail. Shows the question text, total answer count, a breakdown by predicate (e.g. "EU: 42, non-EU: 18"), and a paginated list of individual answers with their disclosed predicates. Polls every 10s for new envelopes (or uses `revalidate` + a refresh button — TBD).

**What it does NOT do.**
- No auth in v0. Askers identify by display name only.
- No payments. No payment fields in the UI.
- No envelope writes. The frontend cannot create or modify envelopes; the DB role used by Next.js doesn't have `INSERT` on `envelopes` or `aggregates`.
- No direct talking to agents. Everything goes via the database, which the broker writes.

**Layout.**

```
hearme-web/
├── package.json
├── next.config.js
├── drizzle.config.ts
├── drizzle/                      # migrations
├── src/
│   ├── app/
│   │   ├── page.tsx              # /
│   │   ├── ask/page.tsx          # /ask
│   │   ├── q/[id]/page.tsx       # /q/[id]
│   │   └── layout.tsx
│   ├── db/
│   │   ├── client.ts             # Drizzle client
│   │   └── schema.ts             # shared with broker via codegen or hand-mirror
│   ├── actions/
│   │   └── create-question.ts    # server action
│   └── components/
│       ├── question-card.tsx
│       ├── ask-form.tsx
│       └── aggregate-chart.tsx
└── README.md
```

---

## 5. `hearme-broker` — dispatcher and verifier

Python service. Single binary. Two responsibilities: dispatch open questions to agents, and verify+persist envelopes that come back.

**Stack.**
- Python 3.11+
- FastAPI (HTTP + optional WebSocket later)
- asyncpg (Postgres)
- pynacl (Ed25519 signatures)
- Pydantic v2 (schema validation)

**HTTP API.**
- `GET /v1/questions/open?since=<iso8601>` — agents poll for new open questions. Returns:
  ```json
  [
    {
      "question_id": "uuid",
      "text": "...",
      "topic": "...",
      "created_at": "2026-05-19T12:00:00Z",
      "closes_at": "2026-05-20T12:00:00Z",
      "nonce": "<random_per_question>"
    }
  ]
  ```
- `POST /v1/register` — agents enroll once at install. Body is the **enrollment bundle** `{self_proofs[], agent_key}` (see §8.5). The broker SNARK-verifies the proofs via the self-bridge, binds `nullifier ↔ agent_key`, and returns the broker-issued **DelegationToken** (the session credential) or `{accepted: false, reason}`. Idempotent: re-registering the same `(nullifier, agent_key)` re-issues a fresh token; a *different* agent_key for an already-bound nullifier is rejected (Sybil).
- `POST /v1/envelopes` — agents submit answers. Body is the envelope (see §8.5). Returns `{accepted: true}` or `{accepted: false, reason}`.
- `POST /v1/memory-commitments` — agents periodically commit a Merkle **root** over their whole local memory (§14.3). Body `{merkle_root, leaf_count, agent_signature}`; the broker assigns and co-signs `anchored_at` and returns the stored commitment. Reveals nothing about memory content. Grounding **audit** of a flagged answer happens out-of-band against a non-broker verifier (user device / TEE, §14.3); the broker only records the pass/fail in `audit_flags`.
- `GET /healthz` — liveness.

For v0, simple HTTP polling is fine. Long-poll or WebSocket is a v0.2 transport upgrade.

**Registration pipeline (once, `POST /v1/register`).** The only path that touches a Self proof.

```
parse enrollment bundle (pydantic): {self_proofs[], agent_key}
  → for each self_proof: verify real SNARK via the self-bridge (@selfxyz/core)
       (rejects if proof invalid OR timestamp outside Self's ±1 day window)
  → ON-CHAIN REGISTRY CHECK (registration only, one Celo RPC read via the self-bridge):
       confirm each proof's identity-registry Merkle root is a CURRENT/known root
       published by Self's on-chain Identity Registry / Hub on Celo, AND the identity
       is registered. This is what makes the off-chain SNARK trustworthy: it proves the
       proof was built against the REAL Self registry (where one-passport→one-identity is
       enforced), not a forged/stale tree an attacker assembled. Reject if the root is
       unknown/stale, the identity is not registered, or the RPC is required-but-unreachable.
       (This is the ONLY on-chain read in the system, and it happens once per identity.)
  → enforce bindings: agent_key == userDefinedData, scope == "hearme-v1",
       all proofs carry the SAME nullifier  → unique_identifier
  → re-derive region (from disclosed nationality) and age_band (from the older-than
       booleans across the proofs) — the broker's value is authoritative
  → atomic registry bind:
       INSERT registrations(unique_identifier, agent_key, disclosed_predicates, expires_at)
       — if nullifier already bound to a DIFFERENT agent_key (and not revoked): reject
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
  → if not no_signal: require a grounding_commitment whose memory_commitments row
       exists, is bound to THIS unique_identifier, and whose anchored_at < question.created_at
       (§14.3); on a random/risk-weighted subset, open an audit_flags('grounding') row (§14.6)
  → INSERT envelope (UNIQUE constraint rejects duplicates)
  → increment aggregates row for question_id
  → write payout_entitlements: baseline now, bonus 'escrowed' until audit + override window (§14.2)
```

If any step fails, the request is rejected with a specific reason code; nothing is written. Reasons are logged but **not** returned in detail to the agent in production (avoid an oracle); v0 returns detailed reasons for debugging.

**Question dispatch.**
- Broker doesn't push; agents poll `/v1/questions/open?since=last_poll`.
- Each agent tracks its own `last_poll` locally from the max broker-supplied
  `created_at` it has seen, not from the agent host's wall clock.
- No per-agent *dispatch* state on the broker (the `registrations` registry is identity state, written once at enrollment, not per question). Restart-safe either way.

**Layout.**

```
hearme-broker/
├── pyproject.toml
├── src/hearme_broker/
│   ├── __init__.py
│   ├── main.py                   # FastAPI app
│   ├── routes/
│   │   ├── questions.py          # GET /v1/questions/open
│   │   ├── register.py           # POST /v1/register  (registration pipeline)
│   │   └── envelopes.py          # POST /v1/envelopes (per-envelope pipeline)
│   ├── verify/
│   │   ├── __init__.py
│   │   ├── self_identity.py      # registration: real SNARK check (via bridge) + bindings + predicate derivation
│   │   ├── bridge_client.py      # HTTP client for the self-bridge (registration only)
│   │   ├── credential.py         # issue + verify the broker-signed DelegationToken; broker keypair
│   │   ├── delegation.py         # per-envelope: token signature + expiry + registry/revocation
│   │   └── envelope.py           # agent signature + linkage
│   ├── db/
│   │   ├── client.py             # asyncpg pool
│   │   └── queries.py
│   ├── aggregates.py             # aggregate helpers
│   ├── eligibility.py            # signed-predicate scope checks
│   └── config.py
└── tests/
    ├── test_verify_delegation.py
    ├── test_verify_envelope.py
    ├── test_predicate_derivation.py   # country→region, thresholds→age_band
    ├── test_uniqueness.py
    └── test_aggregate_recompute.py
```

---

## 6. `hearme-skill` — trust boundaries

```
┌─────────────────────────────────────────────────────────┐
│  hearme-broker (verified above; only contact in steady  │
│  state)                                                 │
└──────────────▲────────────────────┬─────────────────────┘
               │ envelope            │ open-questions poll
┌──────────────┴────────────────────▼─────────────────────┐
│  User device / server — Hermes Agent runtime            │
│  ┌──────────────────────────────────────────────────┐  │
│  │  hearme skill                                     │  │
│  │  - holds agent_key (Ed25519, on-disk encrypted)   │  │
│  │  - holds cached DelegationToken                   │  │
│  │  - never holds passport material                  │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
                 ▲
                 │ rare: install + refresh + revoke
                 │ (install = N quick Self proofs, §8.3)
┌────────────────┴───────────────────────────────────────┐
│  User phone — Self app                                  │
└────────────────────────────────────────────────────────┘
```

Three trust boundaries: broker, agent runtime, phone. The phone is touched only at the three enrollment moments. Steady-state traffic flows entirely between the agent and the broker.

---

## 7. `hearme-skill` — layered architecture

**Production path (v0): a Hermes plugin + cron, not a standalone process.** The skill installs into the user's existing Hermes agent (`hermes_agent.plugins` entry point → `plugin.py:register`) and exposes two tools under the `hearme` toolset: `hearme_list_open_questions` and `hearme_submit_answer` (`tools.py`). A Hermes cron job (`schedule.py`) fires on a schedule; the host agent answers open questions through those tools **using its own configured model and memory**, so there is no second model-provider API key. The privacy-critical work stays deterministic at the tool boundary: the model only sees question text/topic and returns answer text, while policy gating, the delegation token, the nonce, and envelope signing live entirely inside the tools (the model never sees identity material). This realises the local-first decisioning of §1.8 while keeping inference inside the agent the user already trusts and runs.

The layered pipeline below describes the in-process Answerer flow, which v0 retains as the **dev/CI harness** (`dev_runner.py` with `FakeLLMClient`, no network LLM per §12) and as the reference for the deterministic layers the tools reuse (Policy, Envelope, Ledger). Eight layers. Linear flow, no per-question fork. Layers below never call layers above. The Relevance layer (§7.3) short-circuits the flow past Persona and Answerer when the user has no signal on the question — see §1.14.

```
        ┌────────────────────────┐
   in   │  Channel (broker I/O)  │   out
        └────────────┬───────────┘
                     │
        ┌────────────▼───────────┐
        │  Policy (gate)         │
        └────────────┬───────────┘
                     │
        ┌────────────▼───────────┐
        │  Relevance (cheap gate)│──┐
        └────────────┬───────────┘  │ below threshold:
                     │              │ skip Persona+Answerer,
                     │              │ emit no_signal envelope
        ┌────────────▼───────────┐  │
        │  Persona (projection)  │  │
        └────────────┬───────────┘  │
                     │              │
        ┌────────────▼───────────┐  │
        │  Answerer (LLM)        │  │
        └────────────┬───────────┘  │
                     │◄─────────────┘
        ┌────────────▼───────────┐
        │  Envelope              │
        │  reads cached          │
        │  DelegationToken,      │
        │  signs per-question    │
        └────────────┬───────────┘
                     │
        ┌────────────▼───────────┐
        │  Ledger (local SQLite) │
        └────────────┬───────────┘
                     │
        ┌────────────▼───────────┐
        │  UI (Hermes channels)  │
        └────────────────────────┘
```

The DelegationToken is set up out-of-band by `onboarding.py` (see §8) and lives encrypted on disk. Envelope reads it; nobody else does.

### 7.1 Channel — `broker.py`
- Polls the broker at `GET /v1/questions/open?since=<last_seen>` on a configurable interval (default 30s).
- Persists `last_seen` from broker-supplied `Question.created_at`, so local
  host clock skew cannot skip questions.
- Submits envelopes to `POST /v1/envelopes`.
- Backoff, retry, replay. No business logic.

### 7.2 Policy — `policy.py`
- Pure function `(question, user_policy, ledger_stats) -> Decision`.
- Decisions: `answer`, `decline`, `prompt_user`.
- User policy is plain YAML in `~/.hermes/hearme/policy.yaml`. Topics, askers, max/day, min payment, auto-submit window.
- Honeypot detection lives elsewhere; policy never branches on "is this a test".

### 7.3 Relevance — `relevance.py`

The cheap gate. Sits between Policy and Persona. Exists to satisfy §1.14: most users have no formed view on most questions, and we MUST detect that without spending a generation.

- Pure function `(question, memory_handle) -> RelevanceScore` where `RelevanceScore ∈ [0, 1]`.
- **Mechanics.** Embed the question (cheap, retrieval-tier model), run k-NN against the user's memory vector store through Hermes's memory abstraction (never importing a specific provider — §1.11), return a score derived from top-k similarity. No LLM generation, no chain-of-thought.
- **Cost asymmetry.** Retrieval-tier embedding lookup is ~100–1000× cheaper than a generation-tier LLM call. The whole point of this layer is to spend the retrieval cost so we don't spend the generation cost when the expected information yield is near zero.
- **Below threshold (`no_signal` branch).**
  - The flow short-circuits past Persona and Answerer.
  - Envelope (§7.6) emits `{answer: "", no_signal: true, relevance_score: <score>}` and signs it.
  - Cost of this branch is roughly one embedding call.
- **Above threshold.**
  - Flow continues to Persona (§7.4) and Answerer (§7.5).
  - The `relevance_score` is passed through and attached to the envelope as a confidence hint.
- **Threshold is question-stake-dependent.** Higher-staked questions justify a wider net (lower threshold) because the asker is implicitly paying for a broader sample; low-stake questions justify a tighter one. v0 ships a single global threshold and tunes from honeypot telemetry; per-stake tuning is v0.2 (§13).
- **Honeypot compatibility (§1.7, §14.6).** Honeypots are *matched to the claim*, not detected at a single tier. An agent that emits an answer is policed by hidden-instruction honeypots (which require generation to detect); an agent that emits `no_signal` is policed by **known-signal probes** — questions seeded from the user's own memory, where honest retrieval must score above threshold, so `no_signal` is itself the tell. The Relevance layer therefore needs no "is this a test" branch (§1.7); the broker picks the matched honeypot. The earlier claim that a hidden instruction is detectable at the retrieval tier was wrong — see §14.6.
- **Privacy.** Retrieval and the gate decision happen entirely inside the user's runtime. The broker sees only the resulting envelope. Per-user `no_signal` patterns are linkable via `unique_identifier` — same tradeoff as §1.4 — and aggregation must surface only population-level no-signal rates, never per-user no-signal histories.
- **Calibration risk.** Threshold-too-high reproduces the self-selection bias Hearme is trying to escape (VISION.md Challenge #5: only the engaged answer). v0 starts gate-permissive and tightens via telemetry. The right endpoint is somewhere around 60–70% of dispatched questions reaching generation — wide enough to capture latent opinion, narrow enough to make the economics work.
- **Future optimization — opinion fingerprint.** Precompute, at install time and on a weekly refresh, a stable low-dimensional projection of the user's memory across topic axes. New questions match against the fingerprint with a single dot product. No memory scan per question. v0.2.

### 7.4 Persona — `persona.py`
- Pure function `(question, memory_handle) -> PersonaProjection`.
- Only runs when Relevance (§7.3) cleared the gate. If `no_signal`, Persona is skipped entirely.
- Queries Hermes memory through the provider interface; never imports a specific backend.
- In standalone/dev mode, `HEARME_SKILL_MEMORY_BACKEND=chatgpt-export` swaps the default stub provider for the ChatGPT export sidewheel (§1.2.1), backed by `~/.hermes/hearme/chatgpt_memory.sqlite`.
- Output is a **minimal sanitized snapshot** scoped to the question. No raw memory IDs, no source quotes, **no demographic fields** (those live in the DelegationToken).
- Must be deterministic-ish: same question + same memory state → same projection.

### 7.5 Answerer — `answerer.py`
- Single LLM call: `(persona_projection, question, style_guide) -> Answer`.
- Only runs when Relevance (§7.3) cleared the gate. The Answerer LLM call is the expensive part of the pipeline that the gate exists to protect.
- Returns an `Answer` plus a *local-only* rationale string for the audit trail. Rationale is never serialized into the envelope.
- Does **not** see the DelegationToken or `unique_identifier`. Strict separation between identity and inference.

### 7.6 Envelope — `envelope.py` + `delegation.py` + `crypto/`
- `delegation.py` loads the cached **broker-issued `DelegationToken`** (the session credential from `POST /v1/register`, §8.1) from encrypted storage. If expired, the layer fails the request and triggers a refresh prompt via the UI layer — re-registration re-runs the Self proofs; it does **not** silently call the phone in steady state.
- `envelope.py` builds:
  ```
  {
    question_id,
    answer,                   # "" when no_signal is true
    no_signal,                # bool, §7.3
    relevance_score,          # float in [0, 1], §7.3
    grounding_commitment,     # §14.3: {root_id, leaf_indices} into a snapshot anchored before question.created_at; null when no_signal
    delegation_token,         # the broker-issued session credential (see §8)
    agent_signature,          # Sign(agent_key, H(question_id, answer, no_signal, relevance_score, grounding_commitment, nonce, delegation_hash))
    nonce                     # echo of the broker's per-question nonce
  }
  ```
- Both the `no_signal` and `relevance_score` paths produce envelopes with the same structure and the same signature scheme. A `no_signal` envelope is just an envelope with `answer = ""`, `no_signal = true`, and `grounding_commitment = null`; the broker verifies it exactly the same way.
- The `grounding_commitment` (when present) is **inside the signed payload**, so the agent cannot later repudiate which memory snapshot it grounded in (§14.3). It carries only a root reference + leaf indices — never raw memory text; the leaf reveal + inclusion proof are produced only if the answer is later audited.

### 7.7 Ledger — `ledger.py`
- Local SQLite. Schema: `questions`, `answers`, `submissions`, `revocations`, `question_spend`.
- Primary key: `question_id`.
- Records `no_signal` and `relevance_score` for every submission so the user can audit which questions were skipped at the gate and why.
- Encrypted at rest.
- Read-only views to the UI layer.

### 7.8 UI — `ui.py`
- Uses Hermes's messaging-channel abstraction to prompt the user, send summaries, and **notify when the DelegationToken is about to expire** (7 days out).

---

## 8. Onboarding — the DelegationToken handoff

The only time the phone produces cryptographic material for the agent. Built on **Self** ([self.xyz](https://self.xyz)): passport/ID NFC + zk-SNARK, SNARK-verified **off-chain** on the self-bridge (`@selfxyz/core`'s `SelfBackendVerifier`), plus a one-time on-chain Celo Identity-Registry read at registration (§5). Per answer: no chain access.

### 8.0 Why a bridge sidecar (still)

`@selfxyz/core` (verify) and `@selfxyz/qrcode` / `SelfAppBuilder` (request creation) are Node-only; there is no pure-Python verifier. So the Python broker and skill delegate to **`packages/self-bridge`** over HTTP, exactly as the prior design did with zkPassport. The bridge does the cryptography; Python keeps every binding/structural check.

**Transport difference from zkPassport.** zkPassport relayed the finished proof back through its own request channel. Self instead has the **mobile app POST the proof directly to the `endpoint`** configured in the SelfApp — so the self-bridge *is* that endpoint (a callback webhook). The skill then polls the bridge for completion.

### 8.1 Flow

1. User installs the `hearme` Hermes skill. The skill generates an Ed25519 keypair → `agent_key`.
2. The skill asks the **self-bridge** `POST /requests {agentKey, profile}`. The bridge builds one or more SelfApp configs via `SelfAppBuilder` with:
   - `scope = "hearme-v1"` (≤31 ASCII; this *is* the nullifier scope),
   - `endpoint = <self-bridge callback URL>`, `endpointType = staging_https | https`,
   - `userId` = a per-request id, `userDefinedData = hex(agent_key)` (32-byte Ed25519 pubkey → 64 hex chars; **this is the agent-key bind** — the proof commits to it via `userContextData`),
   - disclosures per profile (§8.3): `nationality: true`, and a `minimumAge` threshold.
   It returns `{ requestId, urls: [...] }` (one universal-link/QR per threshold proof).
3. The skill renders each `url` as a QR in turn. User opens the **Self app**, taps their passport (a **mock passport** in staging — §12), approves. The Self app **POSTs the proof to the bridge `endpoint`**.
4. The bridge runs `SelfBackendVerifier.verify(...)` per submission, stores each `VerificationResult` under `requestId`. The skill polls `GET /requests/:id` until all expected proofs are `complete`, receiving for each: `nullifier` (= `unique_identifier`, identical across the threshold proofs since scope+passport are constant), disclosed `nationality`, the `olderThan` boolean, and `userDefinedData` (= `agent_key`).
5. The skill bundles the verified proofs into an **enrollment bundle** and `POST`s it to the broker `POST /v1/register` (it does **not** build the credential itself):
   ```
   EnrollmentBundle = {
     self_proofs,              # array; one verifiable bundle per threshold proof,
                               #   each = base64(canonical_json({attestationId, proof,
                               #                  publicSignals, userContextData}))
     agent_key,                # = userDefinedData inside every proof
   }
   ```
6. The broker runs the **registration pipeline** (§5): SNARK-verifies each proof via the self-bridge (must be within Self's ±1 day window — registration happens right after the scan, so this holds), enforces the bindings, re-derives `region`/`age_band`, atomically binds `nullifier ↔ agent_key` in the `registrations` registry, and returns the **broker-signed DelegationToken**:
   ```
   DelegationToken = {                # the session credential the agent replays per answer
     version = 2,
     scope = "hearme-v1",
     unique_identifier,        # Self nullifier (verified once, now authoritative)
     disclosed_predicates,     # bucketed by the broker: {age_band: "35-49", region: "EU"}
     agent_key,                # bound to unique_identifier in the registry
     issued_at,
     expires_at,               # default issued_at + 90 days (independent of Self's ±1 day proof window)
     broker_signature,         # Sign(broker_key, H(canonical_json(claims-without-signature)))
   }
   ```
   Integrity now comes from the **broker's signature** — its attestation that it verified the Self proofs once. The raw `self_proofs` are **not** stored in the token and never travel again.
7. Skill encrypts and stores the DelegationToken at `~/.hermes/hearme/delegation.token`; the raw `self_proofs` are discarded. Done.

**Graceful degradation.** Only the `18+` proof is required (registration gate). The finer thresholds (§8.3) are optional; a user who declines the extra scans gets `age_band = "18+"` and still participates — they just don't contribute to generational breakdowns.

### 8.2 Refresh
7 days before expiry, UI nudges the user. User opens the Self app, re-runs the proof set; the skill re-registers (`POST /v1/register`) and the broker re-verifies and re-issues the DelegationToken (same nullifier ⇒ idempotent registry bind). If ignored, the agent stops answering and surfaces a weekly nudge. (The Self ±1 day proof window is never a problem: registration always happens immediately after the scan.)

### 8.3 Disclosure profiles

Self discloses a *single* `minimumAge` boolean (or full DOB) per proof and the *raw* nationality — it has no native 5-year-band or "region" predicate. Hearme reconstructs both:

- **Region** ← disclosed `nationality` (ISO-3166 country), mapped to a region (`EU` / continent) and **bucketed by the broker at registration**. The raw country is in the proof, but the proof reaches the broker only once (at `/v1/register`); the broker stores only `region` and discards the raw country — it never re-travels per answer (§1.2).
- **Age band** ← a **multi-threshold ladder**: at install the skill requests several `older-than` proofs at thresholds `[18, 25, 35, 50, 65]` (configurable), all under `scope="hearme-v1"` so they share one nullifier. The set of passing thresholds reconstructs a band, e.g. `older_than(35)=T ∧ older_than(50)=F → "35-49"`. **Exact DOB is never disclosed.**

Profiles (picked once on the phone):
- **Minimal**: `{age_band: "18+", region: "EU/non-EU"}` — one proof.
- **Standard** (default): `{age_band: 5-band ladder, region: continent}` — full threshold set.
- *(Gender and finer geography are intentionally omitted in v0 to respect §1.2; add later only with a clear aggregation need and cohort-size suppression — §13.)*

### 8.4 Revocation
Phone publishes a signed revocation to the broker (`POST /v1/revocations` — out of v0 scope, but the broker has the `revocations` table ready). Broker stops accepting envelopes carrying the revoked `delegation_hash`.

### 8.5 Wire formats

**EnrollmentBundle** (what `POST /v1/register` accepts — install only, never stored):
```json
{
  "self_proofs": [
    "<base64 of canonical_json({attestationId, proof, publicSignals, userContextData})>"
  ],
  "agent_key": "<base64 32 bytes>"
}
```

**DelegationToken** (the broker-issued session credential `POST /v1/register` returns; canonical JSON, deterministic field ordering for hashing):
```json
{
  "version": 2,
  "scope": "hearme-v1",
  "unique_identifier": "<Self nullifier string>",
  "disclosed_predicates": {"age_band": "35-49", "region": "EU"},
  "agent_key": "<base64 32 bytes>",
  "issued_at": "2026-05-19T10:00:00Z",
  "expires_at": "2026-08-17T10:00:00Z",
  "broker_signature": "<base64 64 bytes>"
}
```

`broker_signature = Sign(broker_key, H(canonical_json(token-without-broker_signature)))`. The agent treats the token as opaque; only the broker can mint or validate it.

**Envelope** (what `POST /v1/envelopes` accepts):
```json
{
  "question_id": "<uuid>",
  "answer": "Plain text answer from the agent.",
  "no_signal": false,
  "relevance_score": 0.81,
  "grounding_commitment": { "root_id": "<uuid>", "leaf_indices": [12, 47] },
  "nonce": "<base64 from the question record>",
  "delegation_token": { /* DelegationToken */ },
  "agent_signature": "<base64 64 bytes>"
}
```

`grounding_commitment` is `null` when `no_signal = true`; inclusion proofs and leaf contents are produced only on audit (§14.3), never on the answer path.

`agent_signature = Sign(agent_key, H(question_id || answer || no_signal || relevance_score || grounding_commitment || nonce || delegation_hash))`
`delegation_hash = SHA-256(canonical_json(delegation_token))`

**MemoryCommitment** (what `POST /v1/memory-commitments` accepts / returns; §14.3):
```json
// request — only the root crosses the wire; reveals nothing about memory content
{ "merkle_root": "<hex>", "leaf_count": 2048, "agent_signature": "<base64 64 bytes>" }
// response adds the broker-assigned, co-signed anchor
{ "id": "<uuid>", "anchored_at": "2026-05-21T09:00:00Z", "broker_signature": "<base64 64 bytes>" }
```

---

## 9. Monorepo layout

```
hearme/
├── README.md
├── ARCHITECTURE.md
├── docker-compose.yml             # postgres + broker + web + self-bridge for local dev
├── packages/
│   ├── web/                       # § 4 — Next.js
│   ├── broker/                    # § 5 — Python/FastAPI
│   ├── skill/                     # § 6-8 — Python Hermes skill
│   ├── self-bridge/               # Node sidecar — real Self request + verify (@selfxyz/core)
│   └── proto/                     # shared schemas
│       ├── enrollment.json        # EnrollmentBundle (POST /v1/register input)
│       ├── self.json              # verifiable Self proof bundle (inside EnrollmentBundle)
│       ├── delegation.json        # broker-issued DelegationToken (session credential)
│       ├── envelope.json
│       └── question.json
└── scripts/
    ├── dev-up.sh                  # docker-compose up + seed
    └── mock-onboard.py            # replays a captured proof fixture through /v1/register into a token
```

`packages/proto/` holds the canonical JSON schemas. Both `broker` and `skill` validate against them; `web` doesn't need them (it doesn't touch envelopes).

---

## 10. End-to-end lifecycle of one question

```
asker browser → /ask form → server action → INSERT into questions
                                                   │
                                                   ▼
                                              Postgres (status='open')
                                                   │
                                                   │ broker has no push;
                                                   │ agents poll
                                                   ▼
                                          GET /v1/questions/open?since=…
                                                   │
                                                   ▼
                                              Hermes skill receives Question
                                                   │
                                          ┌────────┴────────┐
                                          │ Policy: gate    │
                                          │ Persona: project│
                                          │ Answerer: LLM   │
                                          │ Envelope: sign  │
                                          └────────┬────────┘
                                                   │
                                                   ▼
                                          POST /v1/envelopes
                                                   │
                                                   ▼
                                          broker.verify pipeline
                                                   │
                                                   ▼
                                          INSERT envelopes (UNIQUE check)
                                          + UPDATE aggregates
                                                   │
                                                   ▼
                                          Postgres
                                                   │
                                                   │ frontend revalidates
                                                   ▼
                                          /q/[id] reflects new answer
```

No phone contact anywhere in this lifecycle. The phone was only needed at install and at refresh.

---

## 11. What v0 skips

Marked `# STUB:` in code and listed in each package's README under "Not yet real":

- **Payments.** No money flows anywhere in v0. The pitch's "fraction of a cent" is deferred to v0.3. No payment fields in the schema.
- **Asker auth and gating.** *Partially implemented (§15.3).* An asker proves a registered identity by presenting their broker-signed DelegationToken to `POST /v1/askers/eligibility`; the broker authenticates it (same trust path as an envelope) and enforces the v0 unlock threshold (≥50 answers / ≥10 signal-bearing, admin override). The web `/ask` gate is on by default (`ASKER_AUTH_REQUIRED`). **Still deferred:** (a) **proof-of-private-key** — v0 auth is credential *possession*, not a signature over the request, so a stolen-but-unexpired token authenticates (hardening: per-request challenge or question-payload signature mirroring the envelope `agent_signature`); (b) a continuous **credit ledger** (v0 is a boolean unlock, not a spend/earn balance) — v0.2; (c) the **fan-out cap** (§15.1) and **buy-credits** path (§15.2, v0.3). The `no_signal` column the signal count reads now exists in the schema and is accepted on the envelope, but **agents do not yet emit it** (the relevance gate of §1.14/§7.3 is skill-side work), so in practice `signal == total` until they do; first-class `no_signal` aggregation (§1.14) is likewise still pending.
- **Real Self proof verification, verify-once — DESIGN (this change).** At `POST /v1/register`, `verify/self_identity.py` runs `@selfxyz/core`'s `SelfBackendVerifier.verify()` through the **self-bridge** (`packages/self-bridge`, a Node sidecar — `@selfxyz/core` is Node-only) on the enrollment bundle, enforces the bindings (agent_key via `userDefinedData`, scope, one shared nullifier ↔ unique_identifier), **derives** `region`/`age_band` from the disclosed nationality and older-than booleans, atomically binds the nullifier ↔ agent_key in the `registrations` registry, and `verify/credential.py` issues a **broker-signed DelegationToken**. Per envelope, only that token's broker signature + registry/revocation are checked — **no Self proof at answer time** (forced by Self's ±1 day proof window; also removes per-envelope SNARK cost and closes the §1.2 transit gap). Mock-passport proofs verify only with `SELF_MOCK_PASSPORT=1` (staging / Celo Sepolia). See `packages/proto/{enrollment,self,delegation}.json` and `packages/broker/src/hearme_broker/verify/`. *Flips to DONE once the code lands; migration plan is `SELF_MIGRATION.md`.* **Sybil hardening:** at registration the broker also performs a one-time on-chain read of Self's Celo Identity Registry to confirm the proof's Merkle root is live (§5) — this anchors the off-chain SNARK to the real registry (where one-passport→one-identity is enforced) and is the only on-chain dependency. **Residual caveats:** (a) a *Celo-side revocation made after registration* is not re-checked per answer (Hearme's own `registrations` registry governs revocation thereafter); (b) one human holding multiple legal passports yields multiple nullifiers — see the Sybil-resistance discussion in `IDENTITY.md`.
- **Memory provider abstraction.** Skill hard-codes one provider (Mem0 or Holographic). Wire the abstraction in v0.2.
- **Multi-channel skill UI.** Telegram only in v0.
- **Revocation propagation.** Broker has the `revocations` table; skill respects expiry; live revocation publishing flow lands in v0.2.
- **Answer-integrity mechanism (§14).** Designed, not yet enforced. v0 may *record* the rows (`grounding_commitment` on envelopes, `memory_commitments`, `audit_flags`, `payout_entitlements`, `fidelity_scores`) but does not yet run grounding audits (§14.3), two-tier honeypot adjudication (§14.6), bonus escrow/clawback (§14.2), or fidelity-weighted aggregation (§14.7). Honeypot signal handling is stubbed in `envelopes.py`. The override oracle (§14.5) needs the review UI wired to write `fidelity_scores`. The canonical memory-leaf definition and the grounding-audit verifier trust model are open (§13). **Tiered payout vesting and external-verification trust unlocks (§14.8) are a future-iteration design; the v0 defense against fake-profile farming is simply to keep the per-answer reward minimal (near inference-cost, little or no bonus `β`).**
- **Real-time frontend.** Frontend polls every 10s on the detail page. WebSocket/SSE in v0.2.
- **Lost-phone recovery.** Re-enroll from a fresh install.

**No silent stubs.** Anything stubbed appears in code with `# STUB:` and in the README.

---

## 12. Testing posture

Each package has its own test suite; one cross-cutting end-to-end suite at the repo root.

### web
- Server action `createQuestion` — happy path + validation.
- Detail page renders aggregate results without exposing raw envelopes.

### broker — the highest-stakes suite
- **Registration (`/v1/register`)** — happy path issues a broker-signed token; ZK failures (proof-invalid, expired-proof/`InvalidTimestamp`, binding mismatch on agent_key/scope, proofs with differing nullifiers) rejected; **Sybil bind** — a second registration of the same nullifier with a *different* agent_key rejected, same agent_key re-issues. The bridge call is mocked in unit tests (a deterministic fake returning a canned `VerificationResult`); a live `SELF_MOCK_PASSPORT=1` (staging) verify is opt-in.
- **Predicate derivation** — `country → region` mapping and `older-than-booleans → age_band` bucketing are pure functions: table-driven tests over edge cases (boundary ages, unmapped countries, partial threshold sets → graceful `18+`). The broker, not the client, is authoritative.
- **Credential (`credential.py`)** — round-trip sign/verify; tampered claim (swapped predicate / agent_key / unique_identifier / expiry) fails the broker signature; a token signed by a non-broker key is rejected.
- **Verify envelope** — happy path, expired token, revoked/unknown registration, bad agent signature, swapped `question_id`, swapped `answer`, swapped `nonce`, swapped `delegation_hash`. Each must reject. **No bridge call** on this path (assert the bridge client is never invoked).
- **Uniqueness** — two envelopes from the same `unique_identifier` for the same `question_id` → second rejects via DB constraint. (Test against a real Postgres in CI.)
- **Aggregate increment** — accepted envelopes update `total_answers` and `by_predicate` without scanning all prior envelopes.
- **Grounding-commitment binding (§14.3)** — an answer (`no_signal=false`) with a missing / foreign / unknown `grounding_commitment`, or one whose `memory_commitments.anchored_at >= question.created_at`, rejects. A `no_signal` envelope with `grounding_commitment=null` is accepted.
- **Incentive ordering (§14.2, simulation)** — under the configured constants, assert `E[honest-answer] > E[honest-no_signal] > E[confabulate] > E[lazy]`; a failed grounding audit/override flips the bonus row to `clawed`.
- **Two-tier honeypot (§14.6)** — a hidden-instruction honeypot answered with a normal opinion fails; a known-signal probe answered with `no_signal` fails; honest behavior on both passes. The skill takes no "is this a test" branch (§1.7).
- **Fidelity update (§14.5)** — a relevance-weighted override lowers `fidelity_scores.score` more for a high-`relevance_score` answer than for a `no_signal` later corrected.

### skill
- **Policy and ledger** — pure / deterministic unit tests.
- **Delegation lifecycle** — fresh load, expiry behavior, signature verification, refresh.
- **Envelope signing** — property tests asserting `agent_signature` binds correctly; rejects on any swap.
- **Persona projection** — snapshot tests against synthetic memory.
- **Answerer** — vcr-style recorded LLM responses; never live LLM in CI.
- **Identity-inference separation** — `Answerer` test double asserts on its call args; must never see DelegationToken or `unique_identifier`.
- **No phone contact in steady state** — across 100 simulated answers, phone bridge is called **zero** times.

### end-to-end (`/scripts/e2e.sh`)
- Spin up postgres + broker + web + self-bridge + a skill. Onboard by scanning a mock passport (`SELF_MOCK_PASSPORT=1`, staging) or replaying a captured proof fixture via `mock-onboard.py` → `POST /v1/register` → broker-issued token; assert a `registrations` row appears.
- Asker posts a question via the web UI (programmatically).
- Mock skill polls broker, answers, submits envelope.
- Assert: envelope appears in DB, aggregate row updated, web detail page renders it.
- **No-bridge-at-answer-time assertion:** the self-bridge is hit during `/v1/register` but **zero** times during `/v1/envelopes`.
- **Boundary-leakage assertion:** scrape the POST body to `/v1/envelopes`; assert it contains exactly `{question_id, answer, no_signal, relevance_score, grounding_commitment, nonce, delegation_token, agent_signature}`, that `delegation_token` carries **no** `self_proofs`, and that `grounding_commitment` carries only a root reference + leaf indices — **no raw memory text** (inclusion proofs and leaf contents appear only under audit, §14.3). No raw proof and no raw memory leave the device per answer.

---

## 13. Open questions

- **Question dispatch transport.** v0 uses HTTP polling. Latency vs simplicity tradeoff: polling every 30s means answers arrive ~30s late. Worth it for v0; move to SSE or WebSocket in v0.2.
- **Epoch-rotated scopes (privacy upgrade).** Replace `scope="hearme-v1"` with `scope="hearme-epoch-<N>"` where N rotates monthly (still ≤31 ASCII). Phone issues a small batch of epoch tokens at install. Benefit: broker can no longer link a user's answers across epochs. Note Self derives the nullifier from `scope`, so a new scope yields a fresh nullifier for the same passport.
- **Broker signing-key management.** The broker-issued DelegationToken is only as trustworthy as the `broker_key`. Where does it live (KMS / HSM / env), and how is it rotated? A rotation needs an overlap window where the broker accepts tokens from the previous key (or forces re-registration). v0: single key in config; harden in v0.2.
- **Credential-vs-registry revocation latency.** Revocation flips `registrations.revoked_at`, checked per envelope — so revocation is immediate, but a stolen token works until then (and short of revocation, until `expires_at`). Shortening the credential TTL trades refresh friction for a tighter compromise window.
- **DelegationToken storage at rest.** OS keychain, passphrase-encrypted file, or Hermes-identity-derived key? Tradeoff between usability and host-compromise resistance.
- **Aggregate semantics for free-form answers.** v0 only aggregates by predicate (e.g., "47 EU users answered"). Semantic clustering of answer text — "65% positive sentiment about X" — is v0.2 and needs careful design to not leak identifying patterns.
- **Frontend identity for askers.** v0 has no auth. At what scale does this become a problem (spam, abuse)? Likely sooner than we'd like.
- **What happens if the agent host is compromised mid-session.** Attacker has agent_key + the broker-issued DelegationToken; can submit answers until the registration is revoked (`registrations.revoked_at`) or the token expires. Broker rate-limit per `unique_identifier` is the v0 bound.
- **Voluntary key transfer (key-handover bribery).** Distinct from host compromise above — there the user is the victim; here the user is the seller. After enrollment the briber needs nothing from the user beyond a one-shot key+token transfer, after which they vote under that `unique_identifier` until expiry (~90 days). MACI is structurally irrelevant because the briber *is* the agent — there is no per-vote contract to unenforce. This is the dominant bribery attack against v0 and is **not currently defended**; see §1.6 for the proposed counter (hardware-bound non-exportable keys + periodic phone re-attestation) and why it is hard: per-platform native bindings (Hermes is Python, hardware-key APIs are native), no-hardware-keystore fallback policy, broker-side attestation acceptance at `POST /v1/register`, and a quantitative softening of §1.13's "phone is cold" property. A stronger v1 shape is a dedicated phone app that holds the final MACI/voting key inside Secure Enclave or StrongBox and signs off agent-prepared answer batches; then the agent can draft, but the transferable desktop/cloud key is no longer the vote authority. Until built, the per-answer-reward-minimization posture of §14.8 is the only thing limiting how big a prize a briber can buy.
- **Memory provider query richness.** Does Hermes's abstraction expose enough for topic-scoped retrieval, or do we need our own layer?
- **Auto-submit window default.** 0 (always prompt) or non-zero (trust the policy)? Shapes user expectations forever.
- **Canonical memory leaf + compaction (§14.3).** "The whole memory" is mutable — providers summarize, edit, and compact (§1.11, §1.2.1). A stable Merkle commitment needs a canonical leaf (`item_id` + salted content hash), a deterministic ordering, and a documented policy so legitimate compaction does not read as tampering.
- **Cherry-picking under grounding proofs (§14.4).** An inclusion proof shows a supporting leaf *exists*, not that the corpus isn't dominated by contradicting ones. Closing it needs fuller disclosure to a trusted (non-broker) verifier or a whole-corpus self-consistency re-derivation — undesigned in v0.
- **Grounding-audit verifier trust model (§14.3, §14.4).** Audit must reveal leaves to *someone* who is not the broker (user device, or a TEE for high-value questions). Device attestation is gameable by an agent that lies to itself; the trust/cost ladder (device → self-consistency → TEE/ZK) is undesigned.
- **Persona-fabrication residual (§14.4).** Commitment proves *consistency*, not *correspondence*: a real human can pre-load a fabricated persona, commit it, and ground every answer in it. Bounded by personhood (one corpus per passport) and the override oracle, but not eliminated; how aggressively to weight against low-history identities is open. **Planned defense:** tiered payout vesting with trust tiers unlocked by opt-in, local-first external-account verification (§14.8); v0 keeps rewards minimal in the meantime.

---

## 14. Answer integrity: honest-signal incentives and grounding

§1.14's cheap relevance gate fixes *unit economics* (don't pay for a generation just to discover the user has no view). It does **not** fix *incentives*. The threat it leaves open is **confabulation**: an agent that runs a real generation but has no genuine signal on the topic and emits a fluent, plausible answer that is the model's prior rather than the user's view. Confabulation passes every honeypot that only asks "did you run inference," because it did. This section makes honesty the dominant strategy and gives confabulation a downside that honeypots structurally cannot.

### 14.1 The bug, precisely
The §1.14 reflex — "price `no_signal` below a real answer" — is exactly backwards. The problem is not that `no_signal` pays less; it is that **answering pays more *unconditionally***. Guaranteed extra pay for any answer is guaranteed extra pay for fluent noise, so the market selects for confabulation and the aggregate drifts toward "what the median model thinks humanity thinks." The fix is to make answering's *extra* pay **conditional on grounding that confabulation cannot fake** (§1.15).

### 14.2 Reprice: baseline reimburses cost; profit comes only from a grounding bonus
Split every payout in two:

- **Baseline `b`, tier-matched to work done.** A `no_signal` earns `b_r` ≈ retrieval-tier cost; an answer earns `b_g` ≈ generation cost. Baseline is pure cost reimbursement — neither branch is profit. This removes the *penalty* on honesty without creating a free-ride: an answer is paid more only because it did more work.
- **Grounding bonus `β`, escrowed and at-risk.** A signal-bearing answer additionally *claims* `β`, the only profit in the system. `β` is released only after the answer survives audit (§14.3) and the override window (§14.5); a failed audit or a user override claws it back (and, for detected confabulation, the baseline too). `no_signal` claims no `β` — correctly, since it bonds no grounding, and its cost is already covered.

Expected payoff per (agent, question), with `c_r`/`c_g` = retrieval/generation cost, `p_s` = audit-survival prob, `K` = clawback, `H` = honeypot penalty:

| State of the world | Action | E[payoff] | |
|---|---|---|---|
| user **has** signal | honest grounded answer | `b_g − c_g + p_s·β` ≈ **+β** (p_s high) | ✅ best |
| user **has no** signal | honest `no_signal` | `b_r − c_r` ≈ **0** | ✅ safe |
| user **has no** signal | confabulate | `b_g − c_g + p_s'·β − p_caught·K` → **< 0** (p_s' low, K real) | ❌ |
| any | lazy (skip inference) | `b_r − p_honeypot·H` → **< 0** | ❌ |

Ordering: **honest-answer > honest-`no_signal` > confabulate > lazy** — honesty dominates in *both* states of the world. The tunable knobs are `β`, audit-rate × `K`, and honeypot-rate × `H`; they are calibrated from telemetry to keep the two bad rows negative. The asker funds both baseline and bonus, and *wants* the `no_signal` census (it is the silent-majority finding of §1.14), so paying `b_r` for it is paying for data, not waste. **v0 records entitlements as `payout_entitlements` rows (escrowed/released/clawed) so the rule is testable before money flows (§11).**

### 14.3 Grounding commitment: prove you didn't invent the evidence
A signal-bearing answer must carry a `grounding_commitment` that ties it to memory the agent **provably already had** — not memory minted to fit the question.

- **Commit the whole corpus, not per-answer items.** A per-answer commitment is worthless: the agent can hash a freshly fabricated item at answer time and "reveal" it. Instead the agent periodically builds a **Merkle tree over its entire local memory** and commits the **root** (`POST /v1/memory-commitments`); the broker assigns and co-signs a timestamp. The root reveals nothing. On audit, the agent reveals the specific grounding **leaves** with Merkle inclusion proofs against that committed root — so the evidence must have existed in the frozen corpus.
- **Public questions force a temporal anchor, not an interactive challenge.** The strongest form — "commit, *then* receive the question" — is unenforceable here, because Hearme questions are public the moment they are posted (`/q/[id]`): the agent may always have seen the question first. The only enforceable ordering is temporal: **the committed snapshot's `anchored_at` MUST pre-date the question's `created_at`.** The broker rejects a `grounding_commitment` that references a snapshot anchored at-or-after the question. This also closes "see the new question → have a conversation to manufacture topical memory → ground in it," because freshly created memory postdates the question. Back-dating is prevented by the broker-co-signed anchor.
- **Privacy.** The root leaks nothing; leaves are revealed only under audit, and only to a **non-broker** verifier (the user's own device, or a TEE for high-value questions — §13). The broker never sees memory content.
- **What the broker checks on the answer path:** the referenced `memory_commitments` row exists, is bound to this `unique_identifier`, and `anchored_at < question.created_at`. The leaf reveal + inclusion proof + semantic-support check happen only for audited answers (`audit_flags`).

### 14.4 What grounding can and cannot prove
> A commitment proves **consistency with a frozen corpus**. It cannot prove **correspondence to a real person** — the agent is the only witness to "what the user actually thinks," and cryptography cannot witness that.

The uncloseable residual is **a-priori persona fabrication**: a user pre-loads fabricated conversations, commits that root, and grounds every answer in a fake persona. No commitment scheme closes this — it merely moves fabrication from per-answer to once-per-identity. It is *bounded*, not eliminated, by non-cryptographic anchors:

1. **Personhood caps it.** The corpus is bound to one Self nullifier = one passport (§1.4). A bot farm of fake personas needs a passport each; the attack collapses to "a real human lies about themselves," which barely moves an aggregate and is the residual no system beats.
2. **A one-shot fake persona is brittle.** A genuine corpus accretes over months, spans unrelated topics, and is cross-consistent. A persona tuned to one topic fails the matched probe battery (§14.6), fails **longitudinal re-asking** (the live-feed product re-asks over time; a fabricated story must stay straight across months it never lived), and fails cross-topic consistency.
3. **The override oracle is the only true correspondence check (§14.5).**

Two further residuals stay on the table (§13): **cherry-picking** (inclusion proves a leaf exists, not that the corpus isn't full of contradicting ones) and **snapshot mutability** (compaction/edits need a canonical leaf definition).

### 14.5 The override loop as ground-truth oracle
§1.12 already makes every answer reviewable. Promote that UI from courtesy feature to **scoring oracle**: each user override is a labeled infidelity event, and the system maintains a per-identity `fidelity_score`.

- **Weight overrides by the claimed `relevance_score`.** A confident answer (high relevance) that gets overridden hurts a lot; a `no_signal` the user later corrects barely hurts. This makes "emit `no_signal` when unsure" the *reputationally* cheap move too, reinforcing §14.2.
- `fidelity_score` drives the §14.2 bonus multiplier, the §14.3 audit rate, and the §14.7 read-side weighting.
- **Sampling.** Full review coverage is unnecessary — even a low review rate gives an unbiased override-rate estimate. Prioritize review of high-relevance claims, where confabulation is most damaging.

### 14.6 Two-tier honeypots, matched to the claim
§1.14/§7.3 wrongly asserted a hidden-instruction honeypot is "detectable at the retrieval tier." It is not: detecting an embedded instruction requires **generation**, and an honest agent that short-circuits at retrieval (the whole point of §1.14) never sees it — so it would emit `no_signal` on a honeypot *through honest behavior*. Honeypots must therefore be matched to the agent's claim:

- **Answer (claims generation)** → **hidden-instruction honeypots** (e.g., "…answer only with `TEST-ACK-7421`"). An agent that truly generated will comply; a random or too-cheap voter won't.
- **`no_signal` (claims retrieval found nothing)** → **known-signal probes**: questions seeded from the user's *own* memory, where they demonstrably have signal. `no_signal` there means the retrieval gate was skipped or miscalibrated — the tell for lazy gating, caught at the tier where it actually lives.

§1.7 still holds: the skill must not branch on "is this a test"; the matching is the *broker's* choice of honeypot, not the agent's.

### 14.7 Read-side weighting (statistical backstop)
Some confabulation always leaks through. On the read side, weight each contribution by `fidelity_score × calibrated relevance`, and publish the `no_signal` rate as a first-class bucket (§1.14). Down-weighting low-fidelity, low-relevance contributions also blunts the **correlated-error / model-monoculture** problem (a million answers from a handful of base models are not a million independent samples): the ungrounded answers are exactly the ones that regress to the shared model prior, so weighting them down recovers effective sample size.

### 14.8 Tiered payout vesting and trust unlocks (future iteration)

§14.2–§14.7 make confabulation *detectably* unprofitable per answer. They do not, on their own, defeat the inverted threat model in §14.4: an **honest agent faithfully serving an adversarial user** who pre-loads a fabricated persona once and farms the per-answer bonus across every question forever. The override oracle (§14.5) — the system's strongest correspondence check — is structurally blind to this case, because a self-fabricating user never overrides their own agent. This section documents the planned defense. It is a **design for future iterations, not v0 behavior** — see *Current posture* at the end.

The strategy is **kill the prize**, in two composable halves: cap the farmable reward (volume decay), and put the bonus at risk until the identity has earned trust (tiered vesting, unlocked by externally-verified data).

**The bond is the user's own withheld bonus, not posted cash.** A literal "post collateral to participate" bond inverts the platform's promise (you get *paid*; you do not pay to play) and would exclude exactly the low-income and censored users VISION §5 exists for. Instead, a fraction of every grounding bonus `β` (§14.2) is **retained in a per-identity vesting escrow** and released only after the identity completes more clean answers without an integrity strike. No cash is ever deposited — the "bond" is earnings-in-escrow, slashable on a detected failure. This **auto-sizes the stake to extraction**: the more you farm, the larger your unvested pipeline at risk. An honest user (strike-probability ≈ 0) loses nothing but a short delay measured in fractions of a cent.

**Tiers gate the vesting depth and the volume cap.** A flat schedule taxes everyone equally; instead the per-epoch volume cap `C` and the vesting depth `D` are functions of a per-identity `trust_tier`, so a fresh identity meets maximum friction exactly when farming is most attractive, and an established one meets almost none:

| Tier | Reached by | Volume cap `C` (β-bearing answers/epoch) | Vesting depth `D` | Withhold % |
|---|---|---|---|---|
| **T0 probation** | fresh Self registration | very low | deep | high |
| **T1** | `N` clean answers + first grounding audit (§14.3) | moderate | medium | medium |
| **T2** | months of coherent history + fidelity above bar (§14.5) + external corroboration | high | shallow | low |
| **T3 trusted** | long, audited, externally-anchored history | ~uncapped | minimal | ~0 |

**Tiers unlock via externally-verified data profiles — opt-in, local-first, proof-only.** The passport binding (§1.4) proves *one human*; it does **not** prove the persona attached to that human is real rather than fabricated (the §14.4 residual). Independent third parties that already witnessed the user's life can close that gap by binding **persona → that human's actual life**, which caps a fabricated persona's richness at the user's real-life richness — directly defeating the "inflate a bigger, more opinionated history than I actually have" attack. To stay compatible with §1.1 (consent is the product) and §1.2 (data minimization at the boundary), this MUST be:

- **Opt-in, never a gate.** Verification *accelerates* tier promotion and raises the fidelity multiplier; it is never required to participate or to be paid. A refusing user is throttled (deeper vesting, lower cap), **not excluded** — preserving access for the privacy-conscious and for VISION §5's censored users, who are least able and least willing to connect such accounts.
- **Local-first and proof-only.** Raw external data (location history, transactions, calendars) never crosses the device boundary. A local verifier (or a TEE for high-value cases, §13) emits only a verdict/score; the §1.2 boundary holds.

Two flavors on a privacy/cost ladder (mirroring §13's device → self-consistency → TEE/ZK ladder):

- **Account-existence stamps (cheap).** Prove possession of *aged, independent* accounts (a years-old email, a bank login, a phone number) bound to this identity, without exposing their contents — the model used by **Gitcoin Passport** and already listed in VISION's identity model ("social account verification," "web-of-trust"). Low privacy cost, modest tier boost, kills throwaway personas.
- **Content cross-consistency (heavyweight; sampled / high-value only).** Check that the persona's memory is consistent with independently-witnessed facts (e.g., chats reference places and times consistent with the user's *own* location timeline), run locally and emitting only a consistency score. Strong fidelity boost, can unlock T3.

**Concrete v1+ attestation menu.** The two flavors above describe *what kinds* of attestation are admissible. The opt-in stamp list below — each one zkTLS proof, with production-grade implementations in Reclaim Protocol, zkPass, and TLSNotary/DECO; the user-side proxy emits a ZK proof binding to a real TLS session with the named service, and the broker learns only the predicate — maps each tier promotion to its sources:

- **Identity-existence (T0 → T1).** Proves the passport corresponds to a real digital life; kills clean-room installs. Predicates:
  - aged Gmail / X / GitHub account
  - real phone number bound to passport-country carrier
  - aged bank account
- **Information-diet (T1 → T2) — opinion-relevant.** Proves the persona is embedded in an information ecosystem of the type that plausibly produces the claimed opinions. **This is the flavor that maps to opinion-poll correspondence specifically:** what users *consume* is a strong proxy for what they think, even when they produce nothing publicly (the user who discusses politics only with their agent and writes only work emails still has a podcast subscription list, an X follow graph, and a newsletter-sender set). It closes the §14.4 residual for opinion polls — a fabricator now needs a multi-year, multi-platform consumption history matching the persona, which services timestamp server-side and cannot be backfilled. Predicates:
  - X / Twitter following list snapshot
  - YouTube subscriptions + watch-category totals
  - Spotify podcast subscriptions
  - Substack subscriptions
  - Reddit subscribed subreddits
  - Gmail newsletter-sender set (sender addresses only, **no content**)
  - Patreon active subscriptions
- **Production / public-record (T2 → T3, where available).** Proves specific historical positions through public acts. Predicates:
  - public political donations (FEC, EU equivalents)
  - public voter registration
  - long-aged public social account with non-trivial posting history

Each stamp is opt-in; refusal is not exclusion. A user who declines all of them stays at T0/T1, throttled by the volume cap and deeper vesting, while their answers still enter the aggregate weighted at read time (§14.7) — preserving access for VISION §5's censored-country users.

**Slash triggers — integrity failures only, never crowd-divergence.** The escrow is slashed only on a *detected integrity failure*: a failed honeypot (§14.6), a failed grounding audit (§14.3), or a failed sampled correspondence audit. It is **never** slashed for disagreeing with the aggregate — punishing contrarians would destroy the minority signal that is the platform's product (VISION §5). Slashing is **graduated and appealable**: a first strike claws back only that answer's `β`; the escrow is slashed only on strong or repeated evidence. The deterrent is bounded by the unvested balance (once `β` vests and is withdrawn there is no custody to claw); the volume cap bounds the rest.

**What this buys, and what it does not.** Volume decay does the heavy lifting and needs *no* detection — a low T0 cap bounds farm profit to cents per epoch regardless of how good the fabrication is, and the only way up is a slow, history- and corroboration-gated climb. The bond/slash amplifies this into negative EV, but its teeth *against persona fabrication specifically* depend on at least the sampled correspondence audit running. External corroboration raises the *fabrication floor* (you must use your real life, and one passport buys one persona); it does **not** prove correspondence-of-*opinion* — a user can connect real data and still confabulate over it. So these compose with, and do not replace, §14.2–§14.7. v0 may record the state as `trust_tier` and `bond_balance` alongside the §14.2 `payout_entitlements` rows, so the rule is testable before money flows (§11).

**Current posture (v0): keep the reward minimal.** None of the above is implemented (§11), and no money flows in v0 anyway. Until the tiered-vesting and external-verification machinery exists, the deliberate defense against fake-profile farming is simply to **keep the per-answer reward minimal — at or near inference-cost reimbursement, with little or no profit bonus `β`.** With negligible profit per answer, building and maintaining a fabricated persona to farm rewards is not worth the effort, so the incentive that drives the §14.4 attack barely exists. This section is precisely what would let `β` rise safely in a later iteration; **raising the bonus before tiered vesting and trust unlocks are in place would re-open exactly the farming hole described here.**

### 14.9 Strongest version: TEE conversation-provenance proxy with cost-bounded withdrawals

The strongest defense against fabricated/confabulated answers is not to detect every fake answer. It is to make high-reward fake signal **more expensive to create than it can ever withdraw**.

For users who want higher answer weight and higher payouts, Hearme can offer an optional model gateway: a **conversation-provenance proxy** in front of OpenRouter or another model router. The user's agent sends normal model calls to the proxy; the proxy runs inside a remotely attested TEE and forwards the request to the chosen model provider. The proxy never persists plaintext prompts or completions. For each turn it stores only a salted/nonce-separated commitment chain:

```
input_commitment  = H(user_secret_or_nonce, turn_index, canonical_input)
output_commitment = H(user_secret_or_nonce, turn_index, canonical_output)
metadata_hash     = H(model_id, provider_id, timestamp, token_counts, billed_cost, tee_measurement)
next_hash         = H(prev_hash, input_commitment, output_commitment, metadata_hash)
```

The proxy records `(unique_identifier, conversation_id, turn_index, next_hash, timestamp, token_counts, billed_cost, tee_measurement)` and periodically anchors the latest chain heads plus the cumulative billed LLM cost to the broker or a public transparency log. The broker learns cost and timing metadata, not message contents. On audit, the user can reveal selected turns locally, to a phone verifier, or to a TEE verifier; the verifier checks the revealed text against the commitments, the chain position, the TEE attestation, and the requirement that the relevant turn predates `questions.created_at`.

This creates a new provenance tier:

| Evidence tier | Requirement | Payout/weight |
|---|---|---|
| Local memory only | Pre-question `memory_commitment`, no external model-spend proof | normal / capped |
| Proxy-provenance memory | Pre-question TEE proxy chain, anchored before the question, selected-turn auditable | higher `β`, higher read-side weight |
| Multi-source provenance | Proxy chain plus zkTLS/account/history stamps (§14.8) | highest tier, still capped |

The key economic rule is a **cost-bounded withdrawal cap**:

```
withdrawable_proxy_bonus(identity, t)
  <= alpha * cumulative_verified_proxy_llm_cost(identity, before=t)

where 0 < alpha < 1
```

For a question created at time `t_q`, only proxy LLM spend whose chain anchor predates `t_q` counts toward the cap for rewards from that question. Post-question spend cannot raise the withdrawable cap for that question. `alpha` is deliberately below 1, so a fabricated persona that exists only to farm Hearme must spend more on pre-question model conversations than it can withdraw from proxy-provenance rewards. The fake history can still exist, but it is a loss-making influence campaign, not a profitable payout farm.

This lets payouts be higher for users who opt into the proxy without reopening the confabulation market:

- **Honest user:** already uses an AI agent through the proxy; Hearme rewards a portion of real, pre-existing model use with higher answer weight and higher `β`.
- **Fabricator-for-profit:** must manufacture aged, cross-topic conversations through the proxy before questions exist; because withdrawals are capped below logged inference cost, the strategy has negative expected payout even before audits and vesting.
- **Ideological/state attacker:** may still accept losses to manipulate public signal. That is a separate threat model handled by published provenance composition, per-identity volume caps, anomaly detection, civic-mode phone approval (§1.6), and lower read-side weight for low-diversity provenance clusters.

Two privacy constraints are non-negotiable. First, commitments must be salted or nonce-separated so short opinions ("yes", "no", "I support X") are not dictionary-attackable from the stored hashes. Second, the proxy must be optional and tier-improving, not mandatory: routing all personal-agent traffic through Hearme would violate the consent/data-sovereignty spirit of §1.1–§1.2. Users who do not use the proxy can still participate, but their answers cannot claim the highest payout/weight tier unless they have another comparable pre-question provenance source.

---

## 15. Asker gating — the answer-credit economy

**Problem.** Posting a question is the one action that imposes cost on *everyone else*. A dispatched question fans out to answering agents, and each one spends its own inference to answer (§1.14; "all inference cost stays with the bot-runner"). So an unrestricted ask is a negative externality: one person's junk question burns the whole network's compute and dilutes the aggregate with noise. v0 has no payments (§11), so we cannot use price as the gate yet — and we deliberately do **not** want to gate on a third-party identity (X login, public posting) or on asker-side Self verification: the first leaks the question and ties our growth to a platform we don't control, the second adds adoption friction to the demand side and is poorly adopted today. We need a gate that (a) is intrinsic to the system, (b) self-limits spam without money, and (c) is forward-compatible with payments.

The gate is built from two mechanisms with **separate jobs** — don't ask one of them to do the other's work.

### 15.1 Fan-out cap — the cost ceiling

A question does **not** need every onboarded agent to answer it. The broker samples a bounded subset of eligible agents per question (sized for the target confidence/scope, not the whole population). This caps the inference cost *per question* regardless of who asks, so even a spam question is cheap to absorb. The fan-out cap is the real cost protection; everything below is about inflow quality and growth, not raw cost. (Sampling is statistically fine for aggregates — a few hundred to a few thousand responses already gives tight bands; publish the realized N per §1.15's "judge the data" principle.)

### 15.2 Answer-credit economy — the inflow gate

Asking is gated on **contribution, expressed as credits**:

- **Earn** credits by answering questions (supplying the network's scarce resource — answer coverage).
- **Spend** credits by asking. A question that fans out to *K* agents costs on the order of *K* credits.

Because spend ≈ fan-out and earn ≈ answers supplied, **credits conserve**: the network can never be asked for more answers than it has supplied. This is a self-balancing invariant, not a heuristic — the same property a seed-ratio gives a torrent swarm. It couples cost-creation directly to cost-bearing.

**Dual acquisition (forward-compatible with payments).** Credits have two acquisition paths, and the asker-gating system is the *same primitive* in both v0 and v0.3:

1. **Earn by answering** — the v0 path. The early population overlaps (operators of answering agents, early adopters, the team), so reciprocity fits and needs no money, no X, no Self-on-asker.
2. **Buy with money (v0.3)** — for genuine demand-side customers (brands, market-research firms, journalists, governments, citizen coalitions per VISION) who will *never* run answering agents. This is the trap to avoid: a pure "must have answered" rule walls off exactly the paying demand that funds the platform. They buy credits instead; the stake reimburses answerer cost (§14.2). When payments land, the free earn-rate shrinks and price becomes the dominant gate.

Same ledger, two ways to top it up. Nothing built for the v0 reciprocity gate is thrown away when payments arrive.

### 15.3 v0 instantiation — the unlock threshold

v0 does not need a continuous credit ledger on day one. It starts with a simpler **boolean unlock**, with the credit economy as the general form it grows into:

- **Unlock to ask:** an agent may post questions once it has submitted **≥ 50 answers total, of which ≥ 10 are signal-bearing** (`no_signal = false`; §1.14). The remaining answers may be `no_signal`. The total threshold bootstraps coverage; the signal-bearing floor is the anti-farming clause — it stops an agent from grinding pure `no_signal` envelopes (the cheap, retrieval-tier branch) just to buy the right to ask. Earning the gate requires real, opinion-bearing contribution.
- **Admin override:** an admin (and designated seed accounts) can post well beyond any threshold, with no answer requirement. This is the bootstrap valve — the network needs questions in circulation before there is a body of answerers to earn against, so the supply of *demand* is primed manually until the loop is self-sustaining.

**Asker auth — how an identity is proven (implemented).** The threshold attaches to an *identity*, so the asker must prove one. They present their broker-signed **DelegationToken** (the same credential their agent holds from onboarding, §8) to `POST /v1/askers/eligibility`. The broker authenticates it on the *same trust path as an envelope* (steps 2–3 of §5): broker signature valid, unexpired, and backed by a live, non-revoked registration bound to the same `agent_key`. Only the broker can read `envelopes`/`registrations` (the privacy boundary), so both the auth and the answer-count live there; it returns `{authorized, can_ask, unique_identifier, remaining_*}`. The web `/ask` action calls it after form validation and blocks unless `can_ask`, then stamps the verified `unique_identifier` on the `askers` row (never derived from user input). Config: `ASKER_UNLOCK_TOTAL_ANSWERS` (50), `ASKER_UNLOCK_SIGNAL_ANSWERS` (10), `ASKER_ADMIN_IDENTIFIERS` (allowlist); `ASKER_AUTH_REQUIRED=false` disables the gate for local demos (asks go through anonymous, `unique_identifier` NULL).

  *v0 limitation (deliberate):* asker auth is **possession** of a live, broker-signed credential, not yet **proof-of-private-key**. A stolen token authenticates until it expires or is revoked. The hardening — a per-request challenge or a signature over the question payload, mirroring the envelope `agent_signature` — is deferred; in v0 the token is signed, expiring (≤90d), and revocable, and the only thing it buys is the right to spend the *thief's own* answer credits, so the downside is bounded. Tracked in §11.

### 15.4 Anti-farming and integrity

The gate is only as honest as the answers behind it. Credit-farming — spewing low-effort answers to earn ask-rights — is the failure mode. Defenses, in increasing strength:

- The **signal-bearing floor** (§15.3) already blocks the cheapest farm (mass `no_signal`).
- Earned credit should eventually be **fidelity-weighted** by the answer-integrity machinery (§14): answers that fail grounding audits (§14.3) or get overturned in the override window (§14.5) earn no credit (or claw it back). Confabulated answers thus can't be laundered into ask-rights.
- Per-identity volume caps and the Sybil bind (one nullifier ↔ one agent_key, §8.1) bound how fast any single human can farm.

For v0, the signal-bearing floor plus basic well-formedness checks are sufficient; fidelity-weighted crediting follows §14's rollout.

### 15.5 X-sharing is a growth boost, not a gate

Posting a *generic* "I use Hearme" promo on X is worth keeping — it's free, on-message advertising and (being generic) preserves the question's anonymity, unlike linking the question itself. But it is a **weak** spam gate (X accounts are cheap and reusable, X ≠ proof-of-personhood) and forcing it resents users and yields low-quality posts. So it is **optional and incentivized**, never the toll: sharing can grant a credit bonus or a reach boost for the asker's question. Distribution and gating are decoupled — the answer-credit economy gates, the optional share grows.

### Summary

| Mechanism | Job | v0 status |
|---|---|---|
| Fan-out cap (§15.1) | Cost ceiling per question | Sample a bounded agent subset |
| Answer-credit economy (§15.2) | Inflow / spam gate, supply bootstrap | Earn-by-answering |
| Unlock threshold (§15.3) | v0 form of the credit gate | ≥50 answers, ≥10 signal-bearing; admin override |
| Buy credits (§15.2) | Demand-side path that doesn't answer | Deferred to v0.3 (payments) |
| X promo share (§15.5) | Growth amplification | Optional, incentivized — never a gate |

The three jobs — cost ceiling, spam gate, growth — get three mechanisms, instead of asking one tweet to do all three.
