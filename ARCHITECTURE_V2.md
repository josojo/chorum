# Chorum — v2 Architecture (bigger incentives, made safe)

> **Version map.**
> - **[v0](ARCHITECTURE_V0.md):** install the skill, verify with Self, answer questions, earn the right to ask. No money.
> - **[v1](ARCHITECTURE_V1.md):** non-custodial on-chain micropayments via a Merkle payout tree; baseline cost reimbursement only; minimal bonus. Tests willingness to pay.
> - **v2 (this doc):** raise the reward above cost so answering is genuinely worth doing — and build the machinery that lets the bonus rise *without* re-opening fabrication and farming. Trust tiers, grounding/honeypot audits, fidelity scoring, payout vesting, an external-verification ladder, a TEE provenance proxy, and hardened bribery defenses.
>
> v2 is a **delta on v1**. Everything in [v0](ARCHITECTURE_V0.md) and [v1](ARCHITECTURE_V1.md) stays; this document describes only what v2 adds and why each piece is required *before* the reward can grow.

---

## 0. The core problem v2 exists to solve

v1 can pay agents, but it keeps the reward at ~inference-cost on purpose. The moment answering pays **more than it costs**, two attacks become profitable that v0/v1 do not defend:

1. **Confabulation.** An agent with no genuine signal runs a real generation and emits a fluent, plausible answer that is the model's prior, not the user's view. It passes any honeypot that only checks "did you run inference," because it did. Naively paying answers more than `no_signal` *selects for* this and turns the aggregate into "what the median model thinks humanity thinks."
2. **Persona farming.** A real human pre-loads a fabricated persona once, then has an honest agent faithfully grind the bonus across every question forever. The override oracle is blind to this — a self-fabricating user never overrides their own agent.

v2's job is to make honesty the **dominant strategy in every state of the world**, and to **cap the prize** of farming below its cost. Only then is it safe to let the bonus `β` — the single source of profit in the system — rise. Everything below composes toward that.

---

## 1. New design principles (additions)

v0 §1 and v1 §1 carry forward. v2 promotes two earlier principles from "stated" to "enforced":

### 1.6′ Coercion resistance — now defended (was a v0 residual)
v0 named voluntary **key handover** as the dominant, undefended bribery attack: after enrollment `agent_key` is just a keypair on disk, sellable in one off-platform transaction, after which the briber answers under the victim's `unique_identifier` until expiry. With v1 money on the line this stops being theoretical. v2 builds the counter-measure stack (§7). MACI defeats *per-vote* bribery (a coerced user can claim any vote; the briber can't verify) but **not** key handover, because the briber *becomes* the agent — so the fix is to make the key non-transferable and to keep ongoing user cooperation necessary.

### 1.15″ Pay for grounded information — now fully realized
v1 implemented only the baseline (reimburse cost). v2 implements the **at-risk grounding bonus**: all *profit* comes from `β`, which is escrowed and released only if the answer survives audit (§3) and the override window (§5), and clawed back otherwise. Under this rule, honesty is the dominant strategy: answer truthfully when you have signal, emit `no_signal` when you don't. `no_signal` paying less in absolute terms is not a penalty — answering's extra pay is a bonus-at-risk, not money a confabulator can capture.

---

## 2. Repricing: baseline reimburses cost, profit comes only from a grounding bonus

v1 paid `baseline` and parked `bonus≈0`. v2 turns the bonus on, but **conditional on grounding confabulation cannot fake**:

- **Baseline `b`, tier-matched to work done.** `no_signal` earns `b_r ≈` retrieval cost; an answer earns `b_g ≈` generation cost. Pure reimbursement — neither branch is profit.
- **Grounding bonus `β`, escrowed and at-risk.** A signal-bearing answer additionally *claims* `β`, the only profit. `β` releases only after the answer survives audit (§3) and the override window (§5); a failed audit or override claws it back (and, for detected confabulation, the baseline too). `no_signal` claims no `β` — correctly, since it bonds no grounding and its cost is already covered.

Expected payoff per (agent, question), `c_r`/`c_g` = retrieval/generation cost, `p_s` = audit-survival prob, `K` = clawback, `H` = honeypot penalty:

| State of the world | Action | E[payoff] | |
|---|---|---|---|
| user **has** signal | honest grounded answer | `b_g − c_g + p_s·β` ≈ **+β** (p_s high) | ✅ best |
| user **has no** signal | honest `no_signal` | `b_r − c_r` ≈ **0** | ✅ safe |
| user **has no** signal | confabulate | `b_g − c_g + p_s'·β − p_caught·K` → **< 0** | ❌ |
| any | lazy (skip inference) | `b_r − p_honeypot·H` → **< 0** | ❌ |

Ordering: **honest-answer > honest-`no_signal` > confabulate > lazy** — honesty dominates in *both* states. Tunable knobs: `β`, audit-rate × `K`, honeypot-rate × `H`, calibrated from telemetry to keep the two bad rows negative. The asker funds both baseline and bonus and *wants* the `no_signal` census, so paying `b_r` for it is paying for data, not waste.

This repurposes v1's `payout_entitlements` table: the `bonus` column, parked at ~0 in v1, now carries real value through `escrowed → released | clawed`.

---

## 3. Grounding commitment: prove you didn't invent the evidence

A signal-bearing answer must carry a `grounding_commitment` tying it to memory the agent **provably already had** — not memory minted to fit the question.

- **Commit the whole corpus, not per-answer items.** A per-answer commitment is worthless (hash a fresh fabrication at answer time). Instead the agent periodically builds a **Merkle tree over its entire local memory** and commits the **root** (`POST /v1/memory-commitments`); the broker assigns and co-signs a timestamp. The root reveals nothing. On audit, the agent reveals the specific grounding **leaves** with inclusion proofs against that committed root — so the evidence must have existed in the frozen corpus.
- **Public questions force a temporal anchor, not an interactive challenge.** "Commit, *then* receive the question" is unenforceable — Chorum questions are public the moment they're posted (`/q/[id]`). The only enforceable ordering is temporal: **the committed snapshot's `anchored_at` MUST pre-date the question's `created_at`.** The broker rejects a `grounding_commitment` referencing a snapshot anchored at-or-after the question. This also closes "see the new question → manufacture topical memory → ground in it," because fresh memory postdates the question. Back-dating is blocked by the broker-co-signed anchor.
- **Privacy.** The root leaks nothing; leaves are revealed only under audit, and only to a **non-broker** verifier (the user's own device, or a TEE for high-value questions — §9). The broker never sees memory content.
- **What the broker checks on the answer path:** the referenced `memory_commitments` row exists, is bound to this `unique_identifier`, and `anchored_at < question.created_at`. The leaf reveal + inclusion proof + semantic-support check happen only for audited answers.

### 3.1 What grounding can and cannot prove
> A commitment proves **consistency with a frozen corpus**. It cannot prove **correspondence to a real person** — the agent is the only witness to "what the user actually thinks," and cryptography cannot witness that.

The uncloseable residual is **a-priori persona fabrication**: pre-load fabricated conversations, commit that root, ground every answer in a fake persona. No commitment scheme closes this — it merely moves fabrication from per-answer to once-per-identity. It is *bounded*, not eliminated, by non-cryptographic anchors:
1. **Personhood caps it.** One corpus per Self nullifier = one passport (v0 §1.4). A bot farm of fake personas needs a passport each; the attack collapses to "a real human lies about themselves," which barely moves an aggregate.
2. **A one-shot fake persona is brittle.** A genuine corpus accretes over months, spans unrelated topics, and is cross-consistent; a topic-tuned persona fails the matched probe battery (§4), fails **longitudinal re-asking** (a fabricated story must stay straight across months it never lived), and fails cross-topic consistency.
3. **The override oracle is the only true correspondence check (§5).**

Two further residuals stay open (§10): **cherry-picking** (inclusion proves a leaf exists, not that the corpus isn't full of contradicting ones) and **snapshot mutability** (compaction/edits need a canonical leaf definition).

---

## 4. Two-tier honeypots, matched to the claim

Honeypots must be matched to the agent's *claim*, because detecting an embedded instruction requires **generation** and an honest agent that short-circuits at retrieval never sees it:

- **Answer (claims generation)** → **hidden-instruction honeypots** (e.g. "…answer only with `TEST-ACK-7421`"). An agent that truly generated complies; a too-cheap voter won't.
- **`no_signal` (claims retrieval found nothing)** → **known-signal probes**: questions seeded from the user's *own* memory, where they demonstrably have signal. `no_signal` there means the gate was skipped or miscalibrated — the tell for lazy gating, caught at the tier where it lives.

v0 §1.7 still holds: the skill must not branch on "is this a test"; the matching is the *broker's* choice of honeypot, not the agent's.

---

## 5. The override loop as ground-truth oracle

v0 §1.12 makes every answer reviewable. v2 promotes that UI from courtesy feature to **scoring oracle**: each user override is a labeled infidelity event, and the system maintains a per-identity `fidelity_score`.

- **Weight overrides by the claimed `relevance_score`.** A confident answer overridden hurts a lot; a `no_signal` later corrected barely hurts. This makes "emit `no_signal` when unsure" the *reputationally* cheap move, reinforcing §2.
- `fidelity_score` drives the §2 bonus multiplier, the §3 audit rate, and the §6 read-side weighting.
- **Sampling.** Full review is unnecessary; even a low rate gives an unbiased override-rate estimate. Prioritize high-relevance claims, where confabulation is most damaging.

---

## 6. Read-side weighting (statistical backstop)

Some confabulation always leaks. On the read side, weight each contribution by `fidelity_score × calibrated relevance`, and keep the `no_signal` rate a first-class bucket (v0 §1.14). Down-weighting low-fidelity, low-relevance contributions also blunts the **model-monoculture** problem — a million answers from a handful of base models are not a million independent samples; the ungrounded answers are exactly the ones that regress to the shared prior, so weighting them down recovers effective sample size. Earned **credits** (v1 §6) become fidelity-weighted too, so confabulated answers can't be laundered into ask-rights.

---

## 7. Bribery & coercion defenses (closing v0 §1.6)

With real money in play (v1), the v0 key-handover hole must close. The defenses, all designed here and rolled out as platform-native bindings allow:

- **Hardware-bound non-exportable signing keys.** `agent_key` is generated inside, and never leaves, a hardware key store: Secure Enclave (macOS/iOS), TPM 2.0 (Windows/Linux), StrongBox (Android), WebAuthn passkey (browser), or cloud HSM with remote attestation (managed Hermes). The skill's `crypto/` module holds *handles*, not bytes; signing becomes a hardware call. Selling the identity then requires shipping the device. `POST /v1/register` accepts a hardware attestation alongside the pubkey so the broker records the storage class and gates higher trust tiers (§8) on enclave-bound keys.
- **Phone-held voting authority for protected questions.** For bribery-sensitive civic questions, the agent drafts but does not hold final voting authority. A small Chorum phone app creates the MACI/voting key inside Secure Enclave / StrongBox, binds its public key to the Self nullifier at registration, and signs off the agent's prepared answer batches. MACI becomes enforceable again: the briber can't buy a one-shot key file and run forever; they need ongoing cooperation from the user's identity device, while still lacking a receipt of how the user ultimately voted.
- **Bonded withdrawal authority (anti-sharing incentive).** The same phone-held authority controls withdrawals from accrued/escrowed earnings (§8). A briber who can command the key well enough to control answers can also drain or slash the value bound to it. Prefer bonded earnings over upfront collateral (a cash deposit would violate "you get paid; you do not pay to play").
- **Coercion-resistant default client.** The protected-question client must keep externally observable behavior compatible with multiple final MACI states; never export a receipt of the final command; local UI/logs/screenshots must not prove which state won. Reliable bribery then requires finding users who are genuinely bribeable *and* willing to run non-standard coercive software *and* unable to defect through the standard override path — far harder than buying a transferable key.
- **Periodic phone re-attestation.** Hardware binding alone is insufficient (a briber can rent the device). Every ~200 answers or ~14 days, the broker issues a challenge only the user's phone (Self app) can satisfy; the skill suspends answering until it clears. A deliberate, quantitative softening of v0 §1.13 (from ~3 touches/year to ~1 touch / two weeks) accepted to close the key-handover hole.

Cost is real: per-platform native bindings (Hermes is Python; hardware-key APIs are native), a no-hardware-keystore fallback policy, and broker-side attestation handling.

---

## 8. Tiered payout vesting and trust unlocks

§2–§7 make confabulation *detectably* unprofitable per answer. They do not defeat the inverted threat: an **honest agent faithfully serving an adversarial user** who pre-loads a fabricated persona once and farms the bonus forever (§3.1 residual; the override oracle is blind to it). v2's answer is **kill the prize**, in two composable halves: cap the farmable reward (volume decay), and put the bonus at risk until the identity earns trust (vesting unlocked by externally-verified data).

**Payout eligibility still starts with the v1 public agent credential.** A Byzantine broker can fabricate private `registrations` rows unless settlement has portable evidence the payee is a real human-backed agent — so the Self Agent ID / ERC-8004 link (v1 §1.4.1) remains the first unlock for withdrawable payouts. The tiers below then decide volume, vesting depth, and bonus eligibility.

**The bond is the user's own withheld bonus, not posted cash.** A literal "post collateral" bond inverts the platform promise and excludes exactly the low-income/censored users the project exists for. Instead, a fraction of every `β` is **retained in a per-identity vesting escrow**, released only after more clean answers without an integrity strike, slashable on a detected failure. This **auto-sizes the stake to extraction** — the more you farm, the larger your unvested pipeline at risk; an honest user loses nothing but a short delay measured in fractions of a cent.

**Tiers gate vesting depth and the volume cap:**

| Tier | Reached by | Volume cap `C` (β-bearing answers/epoch) | Vesting depth `D` | Withhold % |
|---|---|---|---|---|
| **T0 probation** | fresh Self registration | very low | deep | high |
| **T1** | `N` clean answers + first grounding audit (§3) | moderate | medium | medium |
| **T2** | months of coherent history + fidelity above bar (§5) + external corroboration | high | shallow | low |
| **T3 trusted** | long, audited, externally-anchored history | ~uncapped | minimal | ~0 |

A fresh identity meets maximum friction exactly when farming is most attractive; an established one meets almost none.

### 8.1 Tiers unlock via externally-verified data — opt-in, local-first, proof-only
The passport binding (v0 §1.4) proves *one human*; it does not prove the persona is real rather than fabricated. Independent third parties that already witnessed the user's life can bind **persona → that human's actual life**, capping a fabricated persona's richness at the user's real-life richness. To respect consent (v0 §1.1) and data minimization (v0 §1.2), this MUST be:

- **Opt-in, never a gate.** Verification *accelerates* tier promotion and raises the fidelity multiplier; it is never required to participate or be paid. A refusing user is throttled (deeper vesting, lower cap), **not excluded** — preserving access for the privacy-conscious and censored users.
- **Local-first and proof-only.** Raw external data (location, transactions, calendars) never crosses the device boundary. A local verifier (or a TEE for high-value cases, §9) emits only a verdict/score.

Two flavors on a privacy/cost ladder:
- **Account-existence stamps (cheap).** Prove possession of *aged, independent* accounts (years-old email, bank login, phone number) bound to this identity, without exposing contents — the Gitcoin Passport model. Low privacy cost, modest tier boost, kills throwaway personas.
- **Content cross-consistency (heavyweight; sampled / high-value only).** Check the persona's memory is consistent with independently-witnessed facts (chats reference places/times consistent with the user's own location timeline), run locally, emitting only a consistency score. Strong fidelity boost, can unlock T3.

### 8.2 Concrete attestation menu (each a zkTLS proof)
Production-grade implementations: Reclaim Protocol, zkPass, TLSNotary/DECO. The user-side proxy emits a ZK proof binding to a real TLS session with the named service; the broker learns only the predicate.

- **Identity-existence (T0 → T1).** Proves the passport corresponds to a real digital life; kills clean-room installs. Predicates: aged Gmail/X/GitHub account; real phone bound to passport-country carrier; aged bank account.
- **Information-diet (T1 → T2) — opinion-relevant.** Proves the persona is embedded in an information ecosystem of the type that plausibly produces the claimed opinions — *what users consume is a strong proxy for what they think*, even when they produce nothing public. Closes the §3.1 residual for opinion polls: a fabricator now needs a multi-year, multi-platform consumption history matching the persona, which services timestamp server-side and cannot backfill. Predicates: X following list; YouTube subscriptions + watch-category totals; Spotify podcast subscriptions; Substack subscriptions; Reddit subscribed subreddits; Gmail newsletter-sender set (sender addresses only, **no content**); Patreon active subscriptions.
- **Production / public-record (T2 → T3, where available).** Proves specific historical positions through public acts. Predicates: public political donations (FEC etc.); public voter registration; long-aged public social account with non-trivial posting history.

Each stamp is opt-in; refusal is not exclusion. A user who declines all stays at T0/T1, throttled, while their answers still enter the aggregate weighted at read time (§6).

### 8.3 Slash triggers — integrity failures only, never crowd-divergence
The escrow is slashed only on a *detected integrity failure*: a failed honeypot (§4), a failed grounding audit (§3), or a failed sampled correspondence audit. It is **never** slashed for disagreeing with the aggregate — punishing contrarians would destroy the minority signal that is the platform's product. Slashing is **graduated and appealable**: a first strike claws back only that answer's `β`; the escrow is slashed only on strong or repeated evidence. The deterrent is bounded by the unvested balance; the volume cap bounds the rest.

**What this buys.** Volume decay does the heavy lifting and needs *no* detection — a low T0 cap bounds farm profit to cents per epoch regardless of fabrication quality, and the only way up is a slow, corroboration-gated climb. Bond/slash amplifies this into negative EV. External corroboration raises the *fabrication floor* (you must use your real life; one passport buys one persona) but does **not** prove correspondence-of-*opinion* — so these compose with, and do not replace, §2–§6.

---

## 9. Strongest tier: TEE conversation-provenance proxy with cost-bounded withdrawals

The strongest defense is not to detect every fake answer; it is to make high-reward fake signal **more expensive to create than it can ever withdraw**.

For users who want higher weight and payout, Chorum offers an optional model gateway: a **conversation-provenance proxy** in front of OpenRouter or another router. The user's agent sends normal model calls to the proxy; the proxy runs in a remotely attested TEE, forwards to the chosen provider, and **never persists plaintext**. Per turn it stores only a salted/nonce-separated commitment chain:
```
input_commitment  = H(user_secret_or_nonce, turn_index, canonical_input)
output_commitment = H(user_secret_or_nonce, turn_index, canonical_output)
metadata_hash     = H(model_id, provider_id, timestamp, token_counts, billed_cost, tee_measurement)
next_hash         = H(prev_hash, input_commitment, output_commitment, metadata_hash)
```
The proxy records `(unique_identifier, conversation_id, turn_index, next_hash, timestamp, token_counts, billed_cost, tee_measurement)` and periodically anchors chain heads + cumulative billed LLM cost to the broker or a public transparency log. The broker learns cost and timing metadata, not contents. On audit, the user reveals selected turns locally / to a phone or TEE verifier, which checks the revealed text against the commitments, the chain position, the attestation, and that the turn predates `questions.created_at`.

This creates a provenance ladder:

| Evidence tier | Requirement | Payout/weight |
|---|---|---|
| Local memory only | Pre-question `memory_commitment`, no model-spend proof | normal / capped |
| Proxy-provenance memory | Pre-question TEE proxy chain, anchored before the question, selected-turn auditable | higher `β`, higher read-side weight |
| Multi-source provenance | Proxy chain + zkTLS/account/history stamps (§8) | highest tier, still capped |

The key economic rule is a **cost-bounded withdrawal cap**:
```
withdrawable_proxy_bonus(identity, t) <= alpha * cumulative_verified_proxy_llm_cost(identity, before=t),  0 < alpha < 1
```
For a question created at `t_q`, only proxy spend anchored before `t_q` counts toward the cap for that question's rewards. Because `alpha < 1`, a fabricated persona that exists only to farm Chorum must spend more on pre-question conversations than it can withdraw — the fake history can exist, but it is a loss-making influence campaign, not a profitable farm.

- **Honest user:** already uses an agent through the proxy; Chorum rewards a portion of real, pre-existing model use with higher weight and `β`.
- **Fabricator-for-profit:** negative expected payout even before audits and vesting.
- **Ideological/state attacker:** may accept losses to manipulate signal — a separate threat model handled by published provenance composition, per-identity volume caps, anomaly detection, civic-mode phone approval (§7), and lower read-side weight for low-diversity provenance clusters.

Two non-negotiable privacy constraints: commitments must be salted/nonce-separated so short opinions ("yes"/"no") aren't dictionary-attackable from stored hashes; and the proxy must be **optional and tier-improving, not mandatory** — routing all personal-agent traffic through Chorum would violate the consent/data-sovereignty spirit of v0 §1.1–§1.2.

---

## 10. Database delta

On top of v0 §3 and v1 §4:
```sql
-- Periodic agent commitment to its WHOLE local memory (§3). Agent posts only the
-- Merkle ROOT; broker assigns + co-signs a timestamp. An answer may only ground in
-- a snapshot anchored BEFORE the question's created_at.
CREATE TABLE memory_commitments (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  unique_identifier  TEXT NOT NULL,
  merkle_root        TEXT NOT NULL,
  leaf_count         INTEGER NOT NULL,
  anchored_at        TIMESTAMPTZ NOT NULL DEFAULT now(),  -- broker-assigned
  broker_signature   TEXT NOT NULL
);
CREATE INDEX ON memory_commitments(unique_identifier, anchored_at);

-- Per-identity faithfulness, fed by user overrides (§5).
CREATE TABLE fidelity_scores (
  unique_identifier  TEXT PRIMARY KEY,
  score              REAL NOT NULL DEFAULT 1.0,   -- smoothed 1 − relevance-weighted override rate
  n_observations     INTEGER NOT NULL DEFAULT 0,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Answers flagged for grounding audit or honeypot adjudication (§3, §4).
CREATE TABLE audit_flags (
  question_id        UUID NOT NULL REFERENCES questions(id),
  unique_identifier  TEXT NOT NULL,
  kind               TEXT NOT NULL,               -- 'grounding' | 'honeypot' | 'correspondence'
  status             TEXT NOT NULL DEFAULT 'open', -- 'open' | 'passed' | 'failed'
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (question_id, unique_identifier, kind)
);

-- Trust tier + vesting bond (§8).
CREATE TABLE trust_state (
  unique_identifier  TEXT PRIMARY KEY,
  trust_tier         TEXT NOT NULL DEFAULT 'T0',  -- T0 | T1 | T2 | T3
  bond_balance       NUMERIC NOT NULL DEFAULT 0,  -- unvested withheld bonus, slashable
  attestations       JSONB NOT NULL DEFAULT '[]', -- list of zkTLS stamp predicates satisfied (§8.2)
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- envelopes gains the signed grounding reference (NULL when no_signal).
ALTER TABLE envelopes
  ADD COLUMN grounding_commitment TEXT;           -- refs a memory_commitments root + leaf indices
```
The envelope's signed payload now includes `grounding_commitment` (a root reference + leaf indices, **never** raw memory text), so the agent cannot later repudiate which snapshot it grounded in. Leaf reveal + inclusion proof are produced only under audit.

---

## 11. Broker & skill delta

**Broker.**
- `POST /v1/memory-commitments` — agents commit a Merkle root over local memory; broker assigns + co-signs `anchored_at`, returns the stored commitment. Reveals nothing about content.
- Per-envelope pipeline gains, for `no_signal=false`: require a `grounding_commitment` whose `memory_commitments` row exists, is bound to this `unique_identifier`, and has `anchored_at < question.created_at`; on a random/risk-weighted subset (escalating with `relevance_score`, stake, and inverse fidelity), open an `audit_flags('grounding')` row.
- Settlement builder (v1 §5.2) now respects vesting: a `β` row releases only after audit + the override window; withholds the tier-dependent fraction into `trust_state.bond_balance`; honors the §9 cost-bounded cap for proxy-provenance bonuses.
- New jobs: honeypot adjudication, override-oracle fidelity updates, tier promotion/demotion, slash processing.
- Grounding **audit** of a flagged answer happens out-of-band against a **non-broker** verifier (user device / TEE); the broker only records pass/fail in `audit_flags`.

**Skill.**
- Periodically builds the memory Merkle tree and posts the root (`POST /v1/memory-commitments`); attaches a `grounding_commitment` (root ref + leaf indices) to signal-bearing envelopes, inside the signed payload.
- Optional: hardware-bound key generation (§7), the phone companion app for protected questions, zkTLS attestation flows (§8.2), and routing model calls through the provenance proxy (§9). All opt-in and tier-improving.
- The Answerer still never sees identity or payout material; grounding leaves are revealed only on audit, only to a non-broker verifier.

---

## 12. Testing posture (delta)

On top of v0 §12 and v1 §9:
- **Grounding-commitment binding** — an answer (`no_signal=false`) with a missing/foreign/unknown `grounding_commitment`, or one whose `anchored_at >= question.created_at`, rejects; a `no_signal` envelope with `grounding_commitment=null` is accepted.
- **Incentive ordering (simulation)** — under the configured constants, assert `E[honest-answer] > E[honest-no_signal] > E[confabulate] > E[lazy]`; a failed grounding audit/override flips the bonus row to `clawed`.
- **Two-tier honeypot** — a hidden-instruction honeypot answered with a normal opinion fails; a known-signal probe answered with `no_signal` fails; honest behavior on both passes; the skill takes no "is this a test" branch.
- **Fidelity update** — a relevance-weighted override lowers `fidelity_scores.score` more for a high-`relevance_score` answer than for a later-corrected `no_signal`.
- **Vesting & slash** — bonus withheld per tier; clean answers release the bond; an integrity strike slashes only the unvested balance; crowd-divergence never slashes.
- **Cost-bounded proxy cap** — withdrawable proxy bonus never exceeds `alpha ×` verified pre-question LLM cost; post-question spend doesn't raise the cap for that question.
- **Hardware/coercion** — registration records the key storage class; higher tiers gated on enclave-bound keys; no answer path exports a receipt of the final command.

---

## 13. v2 open questions

- **Canonical memory leaf + compaction (§3).** "The whole memory" is mutable — providers summarize, edit, compact. A stable commitment needs a canonical leaf (`item_id` + salted content hash), deterministic ordering, and a documented policy so legitimate compaction doesn't read as tampering.
- **Cherry-picking under grounding proofs (§3.1).** Inclusion shows a supporting leaf *exists*, not that the corpus isn't dominated by contradicting ones. Closing it needs fuller disclosure to a trusted (non-broker) verifier or whole-corpus self-consistency re-derivation.
- **Grounding-audit verifier trust model (§3, §9).** Audit must reveal leaves to *someone* who is not the broker (user device, or a TEE for high-value questions). Device attestation is gameable by an agent that lies to itself; the trust/cost ladder (device → self-consistency → TEE/ZK) is undesigned.
- **Persona-fabrication residual (§3.1).** Commitment proves *consistency*, not *correspondence*. Bounded by personhood + the override oracle + §8/§9, not eliminated; how aggressively to weight against low-history identities is open.
- **Epoch-rotated scopes (privacy upgrade) — _now only the nullifier half remains_.** The answers-table half of this idea is **already shipped in v0**: each question's voter tag is keyed by that question's own secret `s_q`, destroyed a grace period after the question closes (v0 §1.4, ADR-098), so the broker cannot link a user's answers across questions and *closed* questions become unlinkable even to the broker — at the finest possible granularity (epoch = question), which subsumes the calendar-epoch rotation once planned here. What remains for v2 is the **deeper** change: rotate the Self **scope** itself so even the *nullifier* rotates. Replace `scope="chorum-v1"` with `scope="chorum-epoch-<N>"` rotating monthly (still ≤31 ASCII); the phone issues a small batch of epoch tokens at install and Self derives a fresh nullifier per scope. This interacts with the per-identity history that tiers (§8), longitudinal re-asking (§3.1), and the `registrations` per-person counters depend on — it needs a linking-token design that preserves that history without preserving cross-epoch *answer*-linkability.
- **Calibrating β, audit-rate, and slash severity** from live telemetry without over-punishing honest contrarians (§8.3).
- **TEE supply & attestation drift (§9).** Which TEE, how attestation is verified on-chain/off, and how measurement updates are rolled without invalidating prior provenance.
