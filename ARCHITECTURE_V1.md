# Hearme — v1 Architecture (non-custodial payments)

> **Version map.**
> - **[v0](ARCHITECTURE_V0.md):** the working system — install the skill, verify with Self, answer questions, earn the right to ask. No money.
> - **v1 (this doc):** add money. A non-custodial broker assigns which agent answered each question and pays them in micro-amounts settled **on-chain via a Merkle payout tree**. Asking costs credits you can now **buy**. The goal of v1 is to find out whether anyone will actually *pay* to ask.
> - **[v2](ARCHITECTURE_V2.md):** make the reward big enough to matter — trust tiers, grounding/honeypot audits, vesting, a provenance proxy, hardened bribery defenses.
>
> v1 is a **delta on v0**. Everything in [ARCHITECTURE_V0.md](ARCHITECTURE_V0.md) — Self verification, the DelegationToken, envelopes, the verify-all-trust-none pipeline, the layered skill — stays exactly as is. This document describes only what v1 *adds*.

---

## 0. What v1 is, and what it deliberately is not

**The thesis of v1 is price discovery, not incentive engineering.** v0 proved the loop works for free. v1 asks the one question free participation cannot: *will a brand, a journalist, a researcher, a citizen coalition pay real money to put a question to a verified human panel?* To answer that, money has to move — but it has to move in a way that does not require anyone to trust the broker with custody of funds.

So v1 adds exactly two things:

1. **An asker pays to ask.** Credits become buyable with money, not only earnable by answering (v0 §14.3). The funds an asker commits to a question are escrowed **on-chain**, not in a broker bank account.
2. **An answerer gets paid to answer.** The broker assigns which agent answered which question, computes each agent's earnings, and publishes a **Merkle root** of `(payee, amount)` leaves to an on-chain distributor contract. Agents **claim** their own leaf with a Merkle proof and withdraw directly from the contract. The broker never holds or moves user funds.

**What v1 is NOT.** The reward stays **minimal — at or near inference-cost reimbursement, with little or no profit bonus.** This is deliberate and load-bearing: a large bonus before the [v2](ARCHITECTURE_V2.md) anti-confabulation machinery exists would re-open the fake-persona farming hole. v1 is the payment *rails*; v2 is what lets the reward grow safely. So v1 ships the *baseline* of the §14.2 pricing model (reimburse the work) and only the *escrow plumbing* for a bonus, not a bonus worth farming.

---

## 1. New design principles (additions to v0 §1)

v0's §1.1–§1.15 carry forward unchanged. v1 adds:

### 1.4.1 Two identity surfaces — never collapse them
Hearme now has two identity surfaces and they must not be merged:

- **Private answering identity (from v0):** the Hearme-scoped Self nullifier + the broker-signed DelegationToken. Sufficient to answer, enforce one-response-per-human-per-question, and keep raw proofs and public chain identifiers off the answer path.
- **Public payout credential (v1, opt-in):** a **Self Agent ID / ERC-8004** proof-of-human agent credential. Required for any user who wants real, *withdrawable* payouts. It gives the settlement contract and outside verifiers an independently checkable fact — "this signing agent is backed by a real Self-verified human" — instead of trusting a Postgres `registrations` row the broker inserted.

This split is what makes payments non-custodial in spirit as well as plumbing: without it, the v1 payout layer would be trusting the broker not to fabricate registration rows and route rewards to itself. Reusing the public Agent ID as the normal respondent identifier, conversely, would make users more linkable across apps than Hearme needs. So **answering stays private (v0 path); a public credential is linked only when the user wants real money.**

### 1.15′ Baseline reimburses cost; profit is deferred
The marketplace rewards information that corresponds to a real person, never participation. v1 implements only the **baseline** half of that rule (§4): a `no_signal` earns roughly retrieval-tier cost, an answer earns roughly generation cost — neither is profit. The **grounding bonus** (the only real profit) is recorded as an escrowed entitlement but kept at ~zero until [v2](ARCHITECTURE_V2.md) ships the machinery (grounding audits, honeypots, fidelity, vesting) that lets it survive only when genuinely grounded. Paying `no_signal` *less in absolute terms is not a penalty* — answering's extra pay is a bonus-at-risk, not guaranteed money.

---

## 2. v1 system overview (delta)

```
                                   ┌──────────────────────────────────────────┐
                                   │  Blockchain (Celo / L2)                   │
   asker pays  ──────────────────► │  ┌───────────────┐   ┌──────────────────┐ │
   (buy credits / fund question)   │  │ Escrow /      │   │ MerkleDistributor│ │
                                   │  │ Treasury      │──►│ (payout roots)   │ │
                                   │  └───────────────┘   └────────▲─────────┘ │
                                   │   Self Agent ID / ERC-8004     │ claim     │
                                   │   registry (read)              │ (Merkle   │
                                   └────────────────────────────────┼──proof)──┘
                                                                    │
┌─────────────┐   ┌──────────────────┐   ┌────────────┐   ┌────────┴───────────┐
│ hearme-web  │   │  hearme-broker   │   │  Postgres  │   │  hearme-skill      │
│ + buy-credit│──►│  + assignment    │──►│ + payout   │◄──┤  + payout wallet   │
│   checkout  │   │  + Merkle builder│   │   tables   │   │  + claim flow      │
└─────────────┘   └──────────────────┘   └────────────┘   └────────────────────┘
```

The broker is still the only writer of `envelopes`, still verifies every envelope, still never sees a raw Self proof at answer time. It **gains** one job: periodically, it reads the verified envelope record, decides each agent's earnings, builds a Merkle tree, and posts the root on-chain. It **never** custodies funds — money sits in the escrow/distributor contracts; the broker only publishes commitments.

---

## 3. The payment model: how money moves

### 3.1 Funding (the asker side)
- An asker buys **credits** with money (card → fiat on-ramp, or direct stablecoin). Credits are an accounting unit; the *value* backing them is deposited into an on-chain **Escrow/Treasury** contract.
- Posting a question that fans out to *K* agents (v0 §14.1) **escrows** roughly `K × (baseline + bonus_reserve)` worth of value, earmarked to that `question_id`.
- If fewer than *K* agents answer (or the question closes early), the unspent escrow is returned to the asker's credit balance. Nothing is stranded in the broker.

### 3.2 Assignment (the broker's new job)
After a question closes, the broker:
1. Reads the accepted `envelopes` for that `question_id` (it is already the sole authority on which are valid — v0 §5).
2. Maps each `unique_identifier` to a **payout key** (§5): the agent's linked public-credential payout address, or, for users who haven't linked one, a non-withdrawable accounting entry.
3. Computes each agent's earnings = `baseline(no_signal ? b_r : b_g)` + `bonus` (≈0 in v1).
4. Writes `payout_entitlements` rows (§4) recording the rule *before* money flows, so the assignment is auditable.

"Assign which agent answered a question" = step 1–2: the broker is the only party that can read `envelopes`/`registrations` (the v0 privacy boundary), so it is the only party that *can* attribute an answer to a payee — but it does so transparently and the on-chain claim requires the payee to prove they are a real human-backed agent (§1.4.1), so the broker cannot silently pay itself.

### 3.3 Settlement (the Merkle payout tree)
This is the "micropayments via the Merkle tree" the design calls for. Per-answer amounts are tiny (a fraction of a cent); paying each as its own on-chain transfer is economically absurd. So Hearme batches:

```
For a settlement epoch:
  leaves   = [ H(payout_address, cumulative_amount_owed) for each eligible payee ]
  root     = merkleRoot(leaves)
  broker → MerkleDistributor.postRoot(epoch, root, totalAmount)
           (funded by the escrow earmarked to the settled questions)

Each agent, whenever it likes:
  proof    = merkleProof(my_leaf, epoch)
  skill → MerkleDistributor.claim(epoch, payout_address, amount, proof)
           → contract verifies proof against root, pays the agent, marks claimed
```

Properties this buys:
- **Non-custodial.** Funds live in the distributor contract. The broker can post a root and then go offline; agents still claim. The broker can never redirect a claimed payout — the leaf binds the amount to the payee's address.
- **Cheap.** One on-chain transaction (the root) settles thousands of agents. Each agent pays gas only when *it* claims, and can batch claims across epochs.
- **Cumulative leaves** (standard Merkle-drop pattern): each epoch's leaf encodes the *total* owed to date, so a missed epoch is not lost — the next claim supersedes it.
- **Verifiable assignment.** Anyone can recompute the published root from the (privacy-preserving) leaf set the broker commits to; a payee can prove they were under- or over-paid.

> **Chain choice.** Celo (already a Hearme dependency for the Self Identity Registry, v0 §5) is the natural home, but the distributor is chain-agnostic; an L2 with sub-cent gas is equally fine. The escrow currency is a stablecoin so "a fraction of a cent" is a meaningful unit.

### 3.4 Why not just have the broker send payments?
Because that is custody, and custody is exactly the trust we are trying not to require. A custodial broker is a honeypot (regulatory + security), can be compelled to freeze or redirect funds, and gives the answerer no recourse if the broker simply doesn't pay. The Merkle distributor makes the broker a *publisher of commitments*, not a *holder of money* — the same reason v0 made it a publisher of aggregates, not a holder of opinions.

---

## 4. Database delta

v1 adds payout columns/tables; everything in v0 §3 is unchanged.

```sql
-- v0 registrations gains nullable public-credential + payout fields.
ALTER TABLE registrations
  ADD COLUMN agent_id_registry   TEXT,    -- ERC-8004 / Self Agent ID registry address
  ADD COLUMN agent_id_chain_id   INTEGER,
  ADD COLUMN agent_id_token_id   TEXT,    -- the soulbound agent identity token
  ADD COLUMN agent_id_key        TEXT,    -- public key the Agent ID attests to (= agent_key, or delegates to it)
  ADD COLUMN payout_address      TEXT,    -- where claims pay out
  ADD COLUMN payout_authorization TEXT;   -- agent-signed authorization binding payout_address to agent_key

-- Records the payout rule BEFORE money flows (assignment, §3.2).
-- Bonus rows sit 'escrowed' until v2's audit machinery exists; in v1 bonus≈0.
CREATE TABLE payout_entitlements (
  question_id        UUID NOT NULL REFERENCES questions(id),
  unique_identifier  TEXT NOT NULL,
  baseline           NUMERIC NOT NULL DEFAULT 0,  -- tier-matched cost reimbursement (b_r or b_g)
  bonus              NUMERIC NOT NULL DEFAULT 0,  -- grounding bonus; ~0 in v1, at-risk in v2
  status             TEXT NOT NULL DEFAULT 'escrowed', -- 'escrowed' | 'released' | 'clawed'
  settlement_epoch   INTEGER,                     -- which Merkle root settled it; NULL until assigned
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (question_id, unique_identifier)
);

-- Continuous credit ledger (generalizes v0's boolean unlock, §6).
CREATE TABLE credit_ledger (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  unique_identifier  TEXT NOT NULL,
  delta              NUMERIC NOT NULL,            -- +earned (answer), +bought (money), -spent (ask)
  reason             TEXT NOT NULL,               -- 'answer' | 'purchase' | 'ask' | 'refund'
  ref                TEXT,                         -- question_id / settlement_epoch / purchase id
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON credit_ledger(unique_identifier, created_at);

-- One row per posted settlement root; lets anyone audit a claim.
CREATE TABLE settlement_epochs (
  epoch              INTEGER PRIMARY KEY,
  merkle_root        TEXT NOT NULL,
  total_amount       NUMERIC NOT NULL,
  tx_hash            TEXT NOT NULL,               -- on-chain postRoot tx
  posted_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## 5. Broker delta

### 5.1 New endpoints
- `POST /v1/agent-credential` — an already-registered agent links a public **Self Agent ID / ERC-8004** credential to its private Hearme registration. The broker verifies that the public credential's agent key **is** the registered `agent_key`, or explicitly delegates to it via `payout_authorization`, and records only the fields needed for settlement (§4). **Never required for answering** — it is the opt-in bridge from private participation to withdrawable payouts.
- `POST /v1/credits/purchase` — records a money→credit purchase (after the on-ramp/escrow deposit confirms on-chain); appends a `+purchase` row to `credit_ledger`.
- `GET /v1/payouts/me` — an agent (authenticated by DelegationToken, same trust path as an envelope) fetches its claimable leaves: `[{epoch, amount, merkle_proof, root}]`. The skill uses this to call the distributor.

### 5.2 New background job: the settlement builder
Runs per epoch (e.g. hourly/daily):
```
for each question closed since last epoch:
    for each accepted envelope:
        resolve payout_address (registrations) — skip if unlinked (accounting-only)
        compute baseline (+ bonus≈0); write payout_entitlements row
    return escrow surplus (K_funded − K_answered) to asker credit_ledger
aggregate cumulative amount owed per payout_address
build Merkle tree of (payout_address, cumulative_amount) leaves
post root on-chain → MerkleDistributor.postRoot(epoch, root, total)
record settlement_epochs row; mark entitlements settlement_epoch = epoch, status='released'
```
The job is idempotent and restart-safe: cumulative leaves mean a re-run with the same inputs produces the same root, and an already-posted epoch is skipped.

### 5.3 Unchanged
The registration pipeline and per-envelope verification pipeline (v0 §5) are **byte-for-byte the same**. Payments are downstream of a verified envelope; they never touch the verify path. The settlement builder reads `envelopes`; it never writes them.

---

## 6. Asker credit economy (generalizes v0 §14)

v0's boolean unlock becomes a **continuous credit ledger** with two acquisition paths — the *same primitive* in both, which is the point:

1. **Earn by answering** (the v0 path, now a `+answer` ledger entry instead of a counter). Supplying answer coverage — the network's scarce resource — earns credits.
2. **Buy with money** (new in v1). Demand-side customers (brands, market-research firms, journalists, governments, citizen coalitions) who will *never* run answering agents buy credits directly. This is the path that tests willingness to pay, and the trap a pure "must have answered" rule would walk into — it would wall off exactly the paying demand that funds the platform.

Because **spend ≈ fan-out** and **earn ≈ answers supplied**, credits conserve: the network can never be asked for more answers than it has supplied *or paid for*. Asking debits the ledger by ≈ *K* credits (the fan-out); the debited value funds the escrow earmark (§3.1).

The fan-out cap (v0 §14.1) and the signal-bearing floor (v0 §14.2) remain the cost ceiling and the cheapest-farm block. Fidelity-weighted earning — so confabulated answers can't be laundered into credits — is **[v2](ARCHITECTURE_V2.md)**; v1 keeps the v0 signal-bearing floor as the interim defense.

---

## 7. Skill delta

The skill gains a thin **payout module**, isolated from the answer path:
- **Onboarding (opt-in):** after the v0 DelegationToken handoff, the skill can offer to link a public **Self Agent ID** credential and register a `payout_address` (`POST /v1/agent-credential`). Skipping this leaves the agent able to answer and appear in aggregates, earning only non-withdrawable accounting (or testnet rewards).
- **Claiming:** a periodic task calls `GET /v1/payouts/me`, then submits `MerkleDistributor.claim(...)` from the user's payout wallet. Claiming is entirely client-side and optional; the agent can accrue and claim later, or never.
- **Strict separation preserved.** The Answerer still never sees identity material, and now also never sees payout material. The payout wallet key is separate from `agent_key` (or explicitly authorized by it) so a host compromise of the answering key does not by itself drain funds.

The layered answer pipeline (v0 §7) is unchanged.

---

## 8. What v1 still skips → v2

- **A bonus worth farming.** v1 keeps the grounding bonus ~0. Raising it requires the [v2](ARCHITECTURE_V2.md) machinery; doing it sooner re-opens fake-persona farming.
- **Grounding commitments, honeypot adjudication, override-oracle fidelity, fidelity-weighted aggregation and crediting.** All [v2](ARCHITECTURE_V2.md).
- **Trust tiers, payout vesting, external-verification stamps, the provenance proxy.** All [v2](ARCHITECTURE_V2.md).
- **Advanced bribery defenses** (hardware keys, phone-held MACI authority, re-attestation). [v2](ARCHITECTURE_V2.md). The v1 stake is small enough that the per-answer prize a briber could buy stays low.

---

## 9. Testing posture (delta)

On top of v0 §12:
- **Credential link (`/v1/agent-credential`)** — accepts only when the public Agent ID's key equals `agent_key` or carries a valid `payout_authorization`; rejects a credential bound to a different/foreign key. Never gates answering (an unlinked agent still answers).
- **Assignment** — given a fixed set of accepted envelopes, `payout_entitlements` rows are deterministic; unlinked identifiers get accounting-only rows; escrow surplus is refunded to the asker ledger.
- **Merkle settlement** — root is reproducible from the committed leaf set; a valid `(payee, amount, proof)` claims exactly once; a forged leaf or wrong-payee proof is rejected by the contract; cumulative-leaf supersession across epochs pays the delta, not double.
- **Non-custody invariant** — the broker holds no key that can move escrowed funds; posting a root and then killing the broker still lets a test agent claim.
- **Credit conservation** — over a simulated run, `Σ earned + Σ bought ≥ Σ spent`; asks blocked when the ledger is insufficient.
- **Verify path untouched** — assert the per-envelope verification pipeline is byte-identical to v0 (no payment field enters it; the settlement builder never writes `envelopes`).
- **end-to-end** — extend the v0 e2e: asker buys credits (testnet stablecoin) → posts question → skill answers → broker posts a settlement root on a local chain → skill claims its leaf → assert on-chain balance increased and `payout_entitlements.status='released'`.

---

## 10. v1 open questions

- **Self Agent ID binding details.** Whether the Agent ID uses the same Ed25519 `agent_key`, an ECDSA operational key, or a separate payout key authorized by an `agent_signature`; whether payouts go to the NFT owner, a registered agent wallet, a token-bound account, or an agent-signed address; and how settlement checks the on-chain registry without leaking question-level participation. Invariant: public Agent ID is optional for answering, required for real withdrawals.
- **Escrow refund timing.** When exactly to return un-answered fan-out escrow (at question close vs. at epoch settlement) and how to handle late-but-valid answers.
- **Settlement epoch length.** Shorter = faster payouts, more roots (more gas); longer = cheaper, slower. Tune from claim-latency tolerance.
- **Fiat on-ramp & compliance.** Buying credits with a card crosses into payments/KYC regimes; the on-ramp provider and the jurisdictional surface are open. Stablecoin-only is the simplest v1.
- **Pricing the baseline.** `b_r`/`b_g` should track real retrieval/generation cost, which drifts with model prices; needs a refresh mechanism so reimbursement stays honest.
- **Claim gas vs. micro-amounts.** If a single agent's epoch earnings are below claim gas, accrual across epochs (cumulative leaves) helps, but a dust floor / sponsored-claim option may be needed.
- **Does anyone pay?** The actual v1 success metric. If demand-side willingness to pay is low, the bonus economics of v2 are premature regardless of how well the machinery works.
