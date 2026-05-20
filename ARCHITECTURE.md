# Hearme — v0 Architecture

Three components wired together:
1. **`hearme-web`** — Next.js site where askers post questions and anyone can see how agents answered.
2. **`hearme-broker`** — Python service that dispatches questions to agents, verifies returned envelopes, and is the only writer to the answers table.
3. **`hearme-skill`** — Python skill that runs inside a user's Hermes Agent and answers questions on their behalf.

Plus a shared Postgres database, and the user's phone (running ZKPassport) which appears only at install/refresh time.

## 1. Design principles

These are the non-negotiables. Every component below exists to serve one of them.

### 1.1 Consent is the product
The agent answers *on behalf of* the user. If users ever feel surveilled, Hearme dies. The skill must expose a sharp, legible policy surface (topics, askers, daily caps, payment floor) and never silently drift from it. Default to off; opt-in per category.

### 1.2 Personal-data minimization at the boundary
The agent reasons over rich personal memory locally (or with help of a model provider). Only the **answer itself** plus the user's **DelegationToken** (a pre-issued bundle of zkPassport predicate proofs + a stable `uniqueIdentifier`) crosses the device + model boundary. Raw facts, chain-of-thought, source memories, raw passport fields — never.

### 1.3 Predicate disclosure, fixed at install
Demographic disclosure is decided **once**, at install, when the user picks a disclosure level on the phone (e.g. age band, region). The phone bakes the chosen predicates into the DelegationToken. Every answer reuses the same predicate set; askers do **not** negotiate predicates per question. If an asker needs finer slicing, they slice post-hoc on the aggregate, not by demanding new disclosures from the user.

### 1.4 Sybil resistance via stable scoped uniqueness; linkability is bounded and named
The DelegationToken's `uniqueIdentifier` is scoped to `(domain="hearme.network", scope="v1")` — so the same user produces the same identifier across every Hearme answer. The broker uses this for one-answer-per-`(question_id, uniqueIdentifier)` enforcement and for per-user honeypot scoring. This means **the broker can link a user's answers to each other** within Hearme. This is a deliberate v0 tradeoff: it buys "zero time cost per question" (no phone round-trip), and the broker is contractually bound to publish only aggregates. Epoch-rotated scopes (so identifiers rotate weekly/monthly) are a v0.2 upgrade documented in §13.

### 1.5 Verify all, trust none (broker side)
The broker treats every envelope as potentially malicious. It verifies the phone's signature on the DelegationToken, the token's expiry, the agent's per-question signature, the request linkage, and the uniqueness constraint — every time, every envelope. The frontend never sees raw envelopes; it sees only verified writes.

### 1.6 Coercion resistance
The skill must never emit a side-channel artifact (signed receipt, plaintext log shipped off-device, screenshot to cloud) that lets a third party prove how the user answered. The user gets a local audit trail. Nobody else does.

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

### 1.13 Phone is the enrollment device, not a hot dependency
The user's phone (running the ZKPassport app) is touched at exactly three moments: **install**, **refresh** (every 90 days), and **revocation**. In steady state, the phone is never contacted.

### 1.14 Cheap relevance gating before generation

**Problem.** Most users have no formed view on most questions. The economics in VISION.md set the per-response payout at roughly the cost of one LLM inference (~a fraction of a cent). If the skill runs a full generation just to discover the user has no signal on a topic, the marginal answer is worth less than its inference cost — the platform burns budget producing noise and the buyer pays for it. At scale, this inverts the unit economics of the whole marketplace.

**Strategy.** The cost of an answer is not a single number. A retrieval-tier embedding lookup over the user's memory is roughly **100–1000× cheaper** than a generation-tier LLM call. The skill MUST exploit this asymmetry: before invoking the Answerer, run a cheap relevance check (§7.3). If the user has no relevant memory above threshold, emit a `no_signal` envelope and skip generation entirely. The no-signal branch drops from ~$0.001 (full inference) to ~$0.00001 (one embedding lookup).

**Implication.** `no_signal` is not noise — it is real aggregate data ("47% of EU 25–34 respondents had no formed view on synthetic meat") and it is exactly the silent-majority finding that traditional Likert-forced polls hide. Aggregation MUST treat `no_signal` as a first-class bucket, not a discarded row. Honeypots (VISION.md Challenge #6) still apply: an agent that emits `no_signal` on a planted test question fails just as hard as one that fakes an opinion, because the planted instruction is detectable at the retrieval tier too. `no_signal` is not rewarded with the full reward/payout. Honeypots questions that are answered with `no_signal` are never punished.

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
                                     │  User phone — ZKPP app │
                                     └────────────────────────┘
```

**Boundaries.** The frontend and the broker share a database but not code; they communicate only through Postgres. The broker is the only service that can write `envelopes` rows (enforced by DB role grants). The frontend is the only service that creates `questions`. Agents never talk to the frontend; they only talk to the broker.

**Why three services and not one.** The broker's verification logic is security-critical and must be reviewable in isolation. Bundling it into Next.js API routes would tangle it with UI concerns. Keeping it as a separate Python service lets it share verification code with `hearme-skill` and lets us deploy/scale them differently later.

---

## 3. Shared database

Postgres. Schema is owned by `hearme-web` (Drizzle migrations live in that repo) but both services read from it; the broker has its own role with write permission scoped to `envelopes`, `aggregates`, `revocations`.

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
  agent_signature      TEXT NOT NULL,              -- base64 Ed25519
  delegation_hash      TEXT NOT NULL,              -- hash of the DelegationToken used
  submitted_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (question_id, unique_identifier)     -- 1 answer per human per question
);

CREATE TABLE aggregates (
  question_id    UUID PRIMARY KEY REFERENCES questions(id),
  total_answers  INTEGER NOT NULL DEFAULT 0,
  by_predicate   JSONB NOT NULL DEFAULT '{}',       -- {"region:EU": 42, ...}
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE revocations (
  delegation_hash TEXT PRIMARY KEY,
  revoked_at      TIMESTAMPTZ NOT NULL DEFAULT now()
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
- `POST /v1/envelopes` — agents submit answers. Body is the envelope (see §8.5). Returns `{accepted: true}` or `{accepted: false, reason}`.
- `GET /healthz` — liveness.

For v0, simple HTTP polling is fine. Long-poll or WebSocket is a v0.2 transport upgrade.

**Verification pipeline (per envelope).**

```
parse (pydantic)
  → verify phone_signature on DelegationToken (Ed25519, against well-known phone pubkey)
  → check token.expires_at > now()
  → check token.delegation_hash not in revocations
  → recompute expected delegation_hash and compare
  → verify agent_signature over H(question_id, answer, nonce, delegation_hash) using token.agent_key.public
  → check question_id exists, status='open', closes_at > now()
  → check signed predicates are eligible for the question scope
  → INSERT envelope (UNIQUE constraint rejects duplicates)
  → increment aggregates row for question_id
```

If any step fails, the envelope is rejected with a specific reason code; nothing is written. Reasons are logged but **not** returned in detail to the agent in production (avoid an oracle); v0 returns detailed reasons for debugging.

**Question dispatch.**
- Broker doesn't push; agents poll `/v1/questions/open?since=last_poll`.
- Each agent tracks its own `last_poll` locally from the max broker-supplied
  `created_at` it has seen, not from the agent host's wall clock.
- No per-agent state on the broker. This makes the broker stateless and trivial to restart.

**Layout.**

```
hearme-broker/
├── pyproject.toml
├── src/hearme_broker/
│   ├── __init__.py
│   ├── main.py                   # FastAPI app
│   ├── routes/
│   │   ├── questions.py          # GET /v1/questions/open
│   │   └── envelopes.py          # POST /v1/envelopes
│   ├── verify/
│   │   ├── __init__.py
│   │   ├── delegation.py         # phone signature + expiry + revocation
│   │   ├── envelope.py           # agent signature + linkage
│   │   └── well_known.py         # phone pubkey config (v0: hardcoded)
│   ├── db/
│   │   ├── client.py             # asyncpg pool
│   │   └── queries.py
│   ├── aggregates.py             # aggregate helpers
│   ├── eligibility.py            # signed-predicate scope checks
│   └── config.py
└── tests/
    ├── test_verify_delegation.py
    ├── test_verify_envelope.py
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
                 │
┌────────────────┴───────────────────────────────────────┐
│  User phone — ZKPassport app                           │
└────────────────────────────────────────────────────────┘
```

Three trust boundaries: broker, agent runtime, phone. The phone is touched only at the three enrollment moments. Steady-state traffic flows entirely between the agent and the broker.

---

## 7. `hearme-skill` — layered architecture

Eight layers. Linear flow, no per-question fork. Layers below never call layers above. The Relevance layer (§7.3) short-circuits the flow past Persona and Answerer when the user has no signal on the question — see §1.14.

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
- **Honeypot compatibility (§1.7).** Planted test questions are designed so an agent that actually runs *any* inference on the prompt — including the retrieval step — can detect the embedded instruction. The Relevance layer therefore does not let a lazy agent escape detection by emitting `no_signal` on tests. Test questions are calibrated to score above any reasonable threshold; an agent that emits `no_signal` on a planted test fails just as hard as one that fakes an opinion.
- **Privacy.** Retrieval and the gate decision happen entirely inside the user's runtime. The broker sees only the resulting envelope. Per-user `no_signal` patterns are linkable via `unique_identifier` — same tradeoff as §1.4 — and aggregation must surface only population-level no-signal rates, never per-user no-signal histories.
- **Calibration risk.** Threshold-too-high reproduces the self-selection bias Hearme is trying to escape (VISION.md Challenge #5: only the engaged answer). v0 starts gate-permissive and tightens via telemetry. The right endpoint is somewhere around 60–70% of dispatched questions reaching generation — wide enough to capture latent opinion, narrow enough to make the economics work.
- **Future optimization — opinion fingerprint.** Precompute, at install time and on a weekly refresh, a stable low-dimensional projection of the user's memory across topic axes. New questions match against the fingerprint with a single dot product. No memory scan per question. v0.2.

### 7.4 Persona — `persona.py`
- Pure function `(question, memory_handle) -> PersonaProjection`.
- Only runs when Relevance (§7.3) cleared the gate. If `no_signal`, Persona is skipped entirely.
- Queries Hermes memory through the provider interface; never imports a specific backend.
- Output is a **minimal sanitized snapshot** scoped to the question. No raw memory IDs, no source quotes, **no demographic fields** (those live in the DelegationToken).
- Must be deterministic-ish: same question + same memory state → same projection.

### 7.5 Answerer — `answerer.py`
- Single LLM call: `(persona_projection, question, style_guide) -> Answer`.
- Only runs when Relevance (§7.3) cleared the gate. The Answerer LLM call is the expensive part of the pipeline that the gate exists to protect.
- Returns an `Answer` plus a *local-only* rationale string for the audit trail. Rationale is never serialized into the envelope.
- Does **not** see the DelegationToken or `unique_identifier`. Strict separation between identity and inference.

### 7.6 Envelope — `envelope.py` + `delegation.py` + `crypto/`
- `delegation.py` loads the cached `DelegationToken` from encrypted storage. If expired, the layer fails the request and triggers a refresh prompt via the UI layer — it does **not** silently call the phone.
- `envelope.py` builds:
  ```
  {
    question_id,
    answer,                   # "" when no_signal is true
    no_signal,                # bool, §7.3
    relevance_score,          # float in [0, 1], §7.3
    delegation_token,         # the install-time bundle (see §8)
    agent_signature,          # Sign(agent_key, H(question_id, answer, no_signal, relevance_score, nonce, delegation_hash))
    nonce                     # echo of the broker's per-question nonce
  }
  ```
- Both the `no_signal` and `relevance_score` paths produce envelopes with the same structure and the same signature scheme. A `no_signal` envelope is just an envelope with `answer = ""` and `no_signal = true`; the broker verifies it exactly the same way.

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

The only time the phone produces cryptographic material for the agent.

### 8.1 Flow

1. User installs the `hearme` Hermes skill. The skill generates an Ed25519 keypair → `agent_key`.
2. The skill displays a QR code containing: `agent_key.public`, the user's Hermes node id, a fresh onboarding nonce, and the available **disclosure profiles** (see §8.3).
3. User opens the ZKPassport app, scans the QR, and picks a disclosure profile.
4. The phone produces the **DelegationToken**:
   ```
   DelegationToken = {
     zkpassport_proof,
     domain = "hearme.network",
     scope = "v1",
     unique_identifier,        # H(passport_secret, domain, scope)
     disclosed_predicates,     # e.g. {age_band: "25-34", region: "EU"}
     agent_key_authorization,  # phone-signed: "agent_key.public speaks for unique_identifier"
     issued_at,
     expires_at,               # default issued_at + 90 days
     phone_signature           # binds the whole bundle
   }
   ```
5. Phone sends the DelegationToken to the agent over the QR-paired channel.
6. Skill encrypts and stores at `~/.hermes/hearme/delegation.token`. Done.

### 8.2 Refresh
7 days before expiry, UI nudges the user. User opens ZKPassport app, approves, phone re-issues, agent stores new token. If ignored, agent stops answering and surfaces a weekly nudge.

### 8.3 Disclosure profiles
Fixed bundles, picked once on the phone:
- **Minimal**: `{age_band: "18+/under-18", region: "EU/non-EU"}`
- **Standard**: `{age_band: 5-year-bucket, region: continent, gender: optional}`
- **Granular**: `{age_band: 5-year-bucket, country: ISO-3166, gender: optional, urban_rural: optional}`

### 8.4 Revocation
Phone publishes a signed revocation to the broker (`POST /v1/revocations` — out of v0 scope, but the broker has the `revocations` table ready). Broker stops accepting envelopes carrying the revoked `delegation_hash`.

### 8.5 Wire formats

**DelegationToken** (canonical JSON, deterministic field ordering for hashing):
```json
{
  "version": 1,
  "zkpassport_proof": "<base64 bytes>",
  "domain": "hearme.network",
  "scope": "v1",
  "unique_identifier": "<base64 32 bytes>",
  "disclosed_predicates": {"age_band": "25-34", "region": "EU"},
  "agent_key": "<base64 32 bytes>",
  "issued_at": "2026-05-19T10:00:00Z",
  "expires_at": "2026-08-17T10:00:00Z",
  "phone_signature": "<base64 64 bytes>"
}
```

**Envelope** (what `POST /v1/envelopes` accepts):
```json
{
  "question_id": "<uuid>",
  "answer": "Plain text answer from the agent.",
  "nonce": "<base64 from the question record>",
  "delegation_token": { /* DelegationToken */ },
  "agent_signature": "<base64 64 bytes>"
}
```

`agent_signature = Sign(agent_key, H(question_id || answer || nonce || delegation_hash))`
`delegation_hash = SHA-256(canonical_json(delegation_token))`

---

## 9. Monorepo layout

```
hearme/
├── README.md
├── ARCHITECTURE.md
├── docker-compose.yml             # postgres + broker + web for local dev
├── packages/
│   ├── web/                       # § 4 — Next.js
│   ├── broker/                    # § 5 — Python/FastAPI
│   ├── skill/                     # § 6-8 — Python Hermes skill
│   └── proto/                     # shared schemas (DelegationToken, Envelope, Question)
│       ├── delegation.json        # JSON schema
│       ├── envelope.json
│       └── question.json
└── scripts/
    ├── dev-up.sh                  # docker-compose up + seed
    └── mock-phone.py              # issues test DelegationTokens for dev
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
- **Asker auth.** Display name only; anyone can post. Asker accounts and auth land in v0.2.
- **Real zkPassport proof verification.** v0.2 verifies a structured `ZkPassportProof` embedded in `zkpassport_proof`: the broker checks an issuer Ed25519 signature plus four bindings (scope, nullifier ↔ unique_identifier, agent_key commitment, predicate commitment), and registers the nullifier so the same passport can't bind multiple agent_keys without revocation. The issuer signature stands in for SNARK verification of the real circuit; v0.3 swaps it for ICAO-CSCA-rooted ZK verification. See `packages/proto/zkpassport.json` and `packages/broker/src/hearme_broker/verify/zkpassport.py`.
- **Memory provider abstraction.** Skill hard-codes one provider (Mem0 or Holographic). Wire the abstraction in v0.2.
- **Multi-channel skill UI.** Telegram only in v0.
- **Revocation propagation.** Broker has the `revocations` table; skill respects expiry; live revocation publishing flow lands in v0.2.
- **Honeypot signal handling.** Stubbed; broker feedback parsing in v0.2.
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
- **Verify delegation** — happy path, expired token, bad phone signature, revoked token.
- **Verify envelope** — happy path, bad agent signature, swapped `question_id`, swapped `answer`, swapped `nonce`, swapped `delegation_hash`. Each swap must reject.
- **Uniqueness** — two envelopes from the same `unique_identifier` for the same `question_id` → second rejects via DB constraint. (Test against a real Postgres in CI.)
- **Aggregate increment** — accepted envelopes update `total_answers` and `by_predicate` without scanning all prior envelopes.

### skill
- **Policy and ledger** — pure / deterministic unit tests.
- **Delegation lifecycle** — fresh load, expiry behavior, signature verification, refresh.
- **Envelope signing** — property tests asserting `agent_signature` binds correctly; rejects on any swap.
- **Persona projection** — snapshot tests against synthetic memory.
- **Answerer** — vcr-style recorded LLM responses; never live LLM in CI.
- **Identity-inference separation** — `Answerer` test double asserts on its call args; must never see DelegationToken or `unique_identifier`.
- **No phone contact in steady state** — across 100 simulated answers, phone bridge is called **zero** times.

### end-to-end (`/scripts/e2e.sh`)
- Spin up postgres + broker + web + a mock skill (driven by `mock-phone.py` for the DelegationToken).
- Asker posts a question via the web UI (programmatically).
- Mock skill polls broker, answers, submits envelope.
- Assert: envelope appears in DB, aggregate row updated, web detail page renders it.
- **Boundary-leakage assertion:** scrape the POST body to `/v1/envelopes`; assert it contains exactly the 5 fields `{question_id, answer, nonce, delegation_token, agent_signature}`. No extras.

---

## 13. Open questions

- **Question dispatch transport.** v0 uses HTTP polling. Latency vs simplicity tradeoff: polling every 30s means answers arrive ~30s late. Worth it for v0; move to SSE or WebSocket in v0.2.
- **Epoch-rotated scopes (privacy upgrade).** Replace `scope="v1"` with `scope="epoch:<N>"` where N rotates monthly. Phone issues a small batch of epoch tokens at install. Benefit: broker can no longer link a user's answers across epochs.
- **DelegationToken storage at rest.** OS keychain, passphrase-encrypted file, or Hermes-identity-derived key? Tradeoff between usability and host-compromise resistance.
- **Aggregate semantics for free-form answers.** v0 only aggregates by predicate (e.g., "47 EU users answered"). Semantic clustering of answer text — "65% positive sentiment about X" — is v0.2 and needs careful design to not leak identifying patterns.
- **Frontend identity for askers.** v0 has no auth. At what scale does this become a problem (spam, abuse)? Likely sooner than we'd like.
- **What happens if the agent host is compromised mid-session.** Attacker has agent_key + DelegationToken; can submit answers until phone-side revocation. Broker rate-limit per `unique_identifier` is the v0 bound.
- **Memory provider query richness.** Does Hermes's abstraction expose enough for topic-scoped retrieval, or do we need our own layer?
- **Auto-submit window default.** 0 (always prompt) or non-zero (trust the policy)? Shapes user expectations forever.
