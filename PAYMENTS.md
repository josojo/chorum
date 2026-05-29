# Hearme — Payments concept (v0.3, Base Sepolia)

> **Status: concept / design.** No money flows in v0 (ARCHITECTURE.md §11).
> This document specifies the first real payment path: an asker funds a
> question **on-chain**, the broker reserves the funds for the agents who
> answered, and each agent withdraws its own share with its own transaction.
> Target chain is the **Base testnet (Base Sepolia, chainId 84532)**. It builds
> directly on the already-designed payout model in **ARCHITECTURE.md §1.15 and
> §14** and the `payout_entitlements` ledger that already exists "to record the
> rule before money flows."

---

## 0. What this adds, in one paragraph

Today a question is created by `hearme-web` and immediately becomes answerable;
the broker accepts envelopes and (per §14) records `payout_entitlements`
(baseline + at-risk bonus) but **never settles them**. This concept makes
settlement real. A question is created in an **unfunded** state and is *not*
dispatched to agents until the asker has deposited a stake into an on-chain
**escrow contract** on Base Sepolia. As answers arrive and clear the §14 escrow
state machine off-chain, the broker periodically **reserves** the corresponding
amounts on-chain by publishing a single Merkle root of `address → cumulative
amount owed`. Each agent then **claims** its balance directly from the contract
in its own transaction. The broker never takes *direct* custody — there is no
code path that transfers a pool to the broker. The remaining trust is that the
broker **allocates honestly** (names real earners, not its own addresses) rather
than draining a pool to itself via the Merkle leaves; reducing that trust is the
subject of §12.2 (verifiable settlement). Crucially,
**neither side depends on broker liveness to get its money**: after a settlement
grace past the question's end, the asker can unilaterally reclaim any unreserved
remainder, and agents can claim from the published Merkle data even if the broker
disappears forever (§12.1). Funds can never be stuck.

---

## 1. Design principles (how this fits the existing ones)

These extend ARCHITECTURE.md §1; where they touch an existing principle it is
cited.

1. **The broker coordinates; it never *directly* custodies.** The escrow contract
   has no code path that transfers a pool to a broker-controlled address. This
   removes *direct* custody, but the broker still chooses the payout recipients,
   so honest **allocation** remains a trust assumption (and a dishonest broker
   can self-deal — §12.2). Reducing that allocation trust is a goal in its own
   right, for *legal* as much as security reasons (§12.3, principle 7).
2. **Pay for grounded information, not participation (§1.15 verbatim).** The
   on-chain layer is a *settlement rail*, not a new economic model. The split
   into baseline `b` (cost reimbursement, low-risk) and grounding bonus `β`
   (escrowed, at-risk) from §14.2 is unchanged. On-chain reservation timing
   simply mirrors the off-chain entitlement state machine: baseline reserves
   early, `β` reserves only once it transitions `escrowed → released`.
3. **The chain learns as little as possible (§1.2, §1.4).** Per-answer
   linkability is already a named, bounded broker-side fact (§1.4). It must not
   *leak onto a public ledger*. Reservation therefore uses a **per-epoch Merkle
   claim**: the chain shows only "address X claimed amount Y," never which
   question X answered, never X's demographics, never the Self nullifier.
4. **Keep the per-answer reward minimal until §14.8 lands.** ARCHITECTURE.md
   §14.8 / §11 are explicit: until tiered vesting + external-verification trust
   unlocks exist, the defense against fake-persona farming is to **keep the
   reward at or near inference-cost with little or no bonus `β`.** This concept
   does not change that; it gives the small reward a place to actually flow.
   Raising `β` is gated on §14.8, not on this rail.
5. **Testnet first, by construction.** Base Sepolia + a mock ERC-20 means the
   whole loop — fund, reserve, claim, refund — is exercised end-to-end with no
   real value at risk, before any mainnet deployment is considered (§15).
6. **One human, one payout address (extends §1.4).** The Sybil gate is the Self
   nullifier. The payout address is bound to that nullifier at registration with
   the same atomicity as `agent_key`, so a stolen or swapped address cannot
   redirect another human's earnings.
7. **Non-custodial *and* non-discretionary — for legal minimalism (§12.3).**
   Choosing how trustless to be is not only a security question; **operator
   discretion over funds is a regulatory liability.** An operator that determines
   who gets compensated and controls staked funds looks like a money
   transmitter / custodian and needs bilateral contracts with every user. A
   design where payouts are a *deterministic, verifiable function of objective
   inputs* (personhood + signed answer + public schedule), which the operator
   cannot deviate from, avoids that whole category of obligation. So the target
   is **claim-by-proof, not allocate-by-operator**; the discretionary L0 model is
   for **testnet only**, and the architecture must be ready to be
   non-discretionary before any real value flows.

---

## 2. Trust model and the three chosen forks

The forks below were decided before writing (see the three confirmed choices);
each is justified against the existing architecture.

| Fork | Choice | Why |
|---|---|---|
| **Custody** | **In-contract allocation** — broker never *directly* holds funds | `settle` can only move `escrow[qid] → claimable[agent]`; there is no code path `→ broker`. **But this alone does not stop theft:** the broker chooses the recipient addresses in the Merkle leaves, so it can name *itself* as the "agent" and drain a funded pool (§12.2). Direct custody is removed; honest *allocation* is still trusted, and §12.2 is how that trust is reduced. |
| **Token** | **Test ERC-20 stablecoin** (mock USDC, 6 decimals) on Base Sepolia | Matches the $-denominated stake model in VISION ("fund a $1,000 stake → fraction-of-a-cent payouts"). Native ETH would force ETH-denominated math and re-pricing of §14 constants. Cost: one `approve()` before funding. |
| **Reservation** | **Cumulative Merkle distributor, one root per epoch** | Gas-cheap (one `setRoot` tx amortized over all agents) **and** privacy-preserving (the asker→agent payment graph stays off-chain). The simpler `reserve(agent, amount)` ledger would publish exactly the bipartite "who answered what" graph Hearme exists to keep private. |

**Who is trusted for what, after this change:**

- **Asker** trusts the contract, not the broker: their stake is either reserved
  for real responders or reclaimable by them. They can recover the unreserved
  remainder *without the broker* once the settlement grace elapses (§12.1), so a
  dead broker cannot strand their money.
- **Agent** trusts the broker to *allocate honestly* — i.e. to put the agent's
  real earnings into a published root and **not** route them to the broker's own
  addresses. The broker cannot claw a balance an agent already withdrew, and —
  because each settle publishes the leaves on-chain — cannot prevent an agent
  from claiming an amount already in a published root even if it later disappears
  (§12.1). The open residual is the **allocation** itself: a dishonest broker can
  pay fabricated recipients (§12.2). Reducing that trust is what §12.2 is about.
- **Broker** is trusted exactly as today (honest aggregation, §1.4) plus
  **honest allocation** — the largest remaining trust assumption, addressed by
  the verifiable-settlement ladder in §12.2. It holds an **operator key** (EVM
  secp256k1) that is the contract's `broker` role; this is a *new* key, distinct
  from the Ed25519
  DelegationToken signing key (§13 broker-signing-key open question applies to
  it too).

---

## 3. Identity: binding an agent payout address

The chain is EVM (secp256k1 addresses); the existing `agent_key` is Ed25519 and
used only to sign envelopes. They are different keys for different jobs, so an
agent needs a **payout address** in addition to its `agent_key`.

- **The agent owns the key.** At install, the skill generates a fresh secp256k1
  keypair and keeps the private key locally, exactly as it keeps the Ed25519
  agent key (§7.6). Only the holder of that private key can call `claim()`, so
  only the agent can withdraw its reserved funds. The broker never sees the
  private key.
- **Bound at registration, Sybil-safe.** `POST /v1/register` already atomically
  binds `nullifier ↔ agent_key` in `registrations` (ARCHITECTURE.md §5/§8). The
  `EnrollmentBundle` (proto `enrollment.json`) gains a `payout_address` field;
  the broker stores it on the `registrations` row. Rebind rules mirror
  `agent_key`: re-registering the **same** address is idempotent; binding a
  **different** address to a live, non-revoked nullifier is rejected
  (`payout_address_already_bound`) — otherwise an attacker who replays a
  registration could redirect a victim's payouts.
- **The nullifier never goes on-chain.** The broker maps
  `unique_identifier → payout_address` only when it builds Merkle leaves. The
  ledger sees the address; it never sees the Self nullifier or the demographics
  in `disclosed_predicates`.
- **Rotation (lost key)** is a sensitive operation and is **out of scope for
  this concept** — listed in §16. v0.3 treats the payout address as fixed at
  registration; recovery is re-enrollment from a fresh install (mirrors
  ARCHITECTURE.md §11 "lost-phone recovery").

`payout_address` is **not** added to the `DelegationToken` — the per-answer
path (envelopes) does not need it, and keeping it out of the token keeps the
answer hot-path unchanged and the token minimal (§8.5).

---

## 4. On-chain components

### 4.1 Chain

**Base Sepolia**, chainId **84532**. Chosen because it is the requested target,
is the canonical Base testnet, has cheap/abundant gas, and the eventual mainnet
(Base, chainId 8453) is a one-line config flip. The broker already runs a
JSON-RPC chain listener for Self revocations on Celo (`SELF_REVOCATION_*` in the
broker README), so a second EVM listener is an established pattern, not new
infrastructure.

### 4.2 Token

A **test ERC-20** with 6 decimals (mock USDC). For the testnet we deploy a
trivial `MockUSDC` with a public `mint()` faucet so askers can self-fund test
balances. On mainnet this slot becomes the real USDC address; nothing else in
the design changes.

### 4.3 The escrow contract — `HearmeEscrow`

One contract, two layers:

- **Funding layer** — per-question escrow, so unreserved stake is refundable to
  the exact asker who funded it.
- **Payout layer** — a single **cumulative Merkle distributor**, so the broker
  reserves to thousands of agents in one transaction and agents claim whenever
  they like.

```solidity
// SPDX-License-Identifier: MIT
// Solidity ^0.8.24 — illustrative interface, not final code.
contract HearmeEscrow {
    IERC20  public immutable token;     // mock USDC on Base Sepolia
    address public broker;              // operator role: settle / closeQuestion ONLY — never moves funds to itself
    uint256 public constant SETTLEMENT_GRACE = 14 days;  // broker's window to settle after a question's closesAt

    // --- funding layer (per question) ---
    struct Pool {
        address asker;     // who funded — the ONLY address a refund can pay
        uint256 funded;    // total deposited
        uint256 settled;   // total moved out to the agent distributor
        uint64  closesAt;  // question end timestamp (asker-supplied, broker-validated before dispatch)
        bool    closed;    // broker fast-path flag: lets the asker refund early; never required
    }
    mapping(bytes32 => Pool) public pools;     // questionId (UUID as bytes32) -> pool

    // --- payout layer (global cumulative Merkle distributor) ---
    bytes32 public root;                       // current cumulative root
    uint256 public epoch;                      // increments each settle
    mapping(address => uint256) public withdrawn;   // lifetime claimed per agent

    event QuestionFunded(bytes32 indexed qid, address indexed asker, uint256 amount, uint64 closesAt);
    event Settled(bytes32 indexed qid, uint256 amount, uint256 epoch, bytes32 root, bytes leaves);
    event Claimed(address indexed agent, uint256 amount, uint256 newTotal);
    event Refunded(bytes32 indexed qid, address indexed asker, uint256 amount, bool unilateral);

    // ASKER: deposit stake for a question. Requires prior token.approve().
    // `closesAt` is the question's end timestamp; the broker only dispatches the
    // question if it matches questions.closes_at, so a lying asker just gets a
    // never-live question (§8.2). Top-ups allowed while !closed.
    function fundQuestion(bytes32 qid, uint256 amount, uint64 closesAt) external {
        require(amount > 0 && closesAt > block.timestamp);
        Pool storage p = pools[qid];
        if (p.asker == address(0)) { p.asker = msg.sender; p.closesAt = closesAt; }
        require(p.asker == msg.sender && p.closesAt == closesAt, "funder/deadline mismatch");
        require(!p.closed, "closed");
        token.transferFrom(msg.sender, address(this), amount);
        p.funded += amount;
        emit QuestionFunded(qid, msg.sender, amount, closesAt);
    }

    // BROKER (onlyBroker): move `amount` from this question's pool into the
    // global distributor and publish the new cumulative root. `leaves` carries
    // the epoch's (address,cumulative) set as calldata so ANYONE can rebuild
    // their own proof from chain data alone — agents can claim even if the
    // broker is gone forever (§12.1). `amount` is the sum of NEW allocations
    // attributable to `qid` this settle — for per-question refund math + transparency.
    function settle(bytes32 qid, uint256 amount, bytes32 newRoot, bytes calldata leaves)
        external onlyBroker
    {
        Pool storage p = pools[qid];
        require(p.funded - p.settled >= amount, "overspend");
        p.settled += amount;
        epoch += 1;
        root = newRoot;            // cumulative; supersedes the prior root
        emit Settled(qid, amount, epoch, newRoot, leaves);
    }

    // AGENT: claim everything owed so far. leaf = keccak256(abi.encode(agent, cumulative)).
    // Depends only on `root` (on-chain) + a proof (rebuildable from Settled.leaves) — never on the broker.
    function claim(uint256 cumulative, bytes32[] calldata proof) external {
        require(MerkleProof.verify(proof, root, _leaf(msg.sender, cumulative)), "bad proof");
        uint256 amount = cumulative - withdrawn[msg.sender];   // reverts if < (double-claim safe)
        require(amount > 0, "nothing to claim");
        withdrawn[msg.sender] = cumulative;
        token.transfer(msg.sender, amount);
        emit Claimed(msg.sender, amount, cumulative);
    }

    // ASKER (no broker needed): reclaim the UNRESERVED remainder of OWN question.
    // Allowed once the broker fast-path flag is set (`closed`) OR unconditionally
    // after the settlement grace (`closesAt + SETTLEMENT_GRACE`). The second arm
    // is the escape hatch: funds can never be stuck even if the broker dies forever.
    function refund(bytes32 qid) external {
        Pool storage p = pools[qid];
        require(msg.sender == p.asker, "not asker");
        bool unilateral = block.timestamp >= uint256(p.closesAt) + SETTLEMENT_GRACE;
        require(p.closed || unilateral, "too early");
        uint256 remainder = p.funded - p.settled;
        require(remainder > 0, "nothing to refund");
        p.funded = p.settled;                            // zero the refundable part; blocks any later settle
        token.transfer(p.asker, remainder);
        emit Refunded(qid, p.asker, remainder, unilateral);
    }

    // BROKER fast path: after the final settle, unlock the asker's refund before
    // the grace elapses. Pure acceleration — refund still only ever pays p.asker,
    // so the broker cannot use this to redirect or capture funds.
    function closeQuestion(bytes32 qid) external onlyBroker { pools[qid].closed = true; }
}
```

**Why a cumulative distributor.** Each new root encodes every agent's *lifetime*
owed total. An agent claims the delta `cumulative − withdrawn[agent]`, so:

- **Double-claim is structurally impossible** — `withdrawn` is monotonic and the
  subtraction reverts on a stale proof.
- **Agents can batch** — claim once a month across many questions, paying gas
  once, which is essential once payouts are fractions of a cent (§1.15).
- **The broker reserves in O(1) on-chain cost** — one `setRoot`/`settle` per
  epoch regardless of how many agents earned.

This is the well-worn "cumulative Merkle drop" pattern; the only Hearme-specific
piece is that the root is *re-published each epoch* with updated totals rather
than frozen.

**Solvency invariant the broker must preserve:**
`Σ cumulative_owed(all agents in current root) ≤ Σ pools[*].settled`. The broker
never settles more out of a pool than was funded (`require` above), and never
builds a root whose owed-total exceeds total settled. An attempt to over-claim
beyond the contract's token balance simply reverts on `transfer`.

---

## 5. Mapping the §14 entitlement state machine onto reservations

The off-chain `payout_entitlements` ledger (ARCHITECTURE.md §3, §14.2) stays the
**source of truth for who earned what**. The chain is a downstream settlement of
*released* entitlements only. No new economic decisions are made on-chain.

| `payout_entitlements` event (off-chain) | On-chain effect |
|---|---|
| Envelope accepted → row inserted: `baseline` set, `bonus` `escrowed` | none yet |
| Baseline is low-risk → eligible to reserve immediately (or next epoch) | included in next cumulative root via `settle` |
| Bonus survives audit (§14.3) + override window (§14.5) → `escrowed → released` | the released `bonus` added to the agent's cumulative in the next root |
| Bonus fails audit / user override → `escrowed → clawed` | **never reserved**; stays in `pools[qid]`, ultimately refundable to the asker |
| Question closes, all entitlements resolved | broker `closeQuestion(qid)`; asker (or broker) calls `refund(qid)` for the unreserved remainder |

Per epoch the broker:

1. Reads all `payout_entitlements` whose `baseline`/`released bonus` is not yet
   reserved on-chain.
2. Groups by `payout_address` (via `registrations`), computes each address's new
   **cumulative** owed = prior cumulative + newly-reservable amount.
3. Builds the Merkle tree of `keccak256(abi.encode(address, cumulative))`,
   computes the root.
4. Calls `settle(qid, amount, newRoot, leaves)` — one call per question that
   contributed new allocations this epoch (each debits its own pool for refund
   accuracy), the last of which carries the final `newRoot`. The `leaves`
   calldata publishes the epoch's `(address, cumulative)` set on-chain so proofs
   are reconstructible without the broker (§12.1). *(Alternatively a single
   `settleBatch(qids[], amounts[], newRoot, leaves)` to keep it one transaction;
   see §16.)*
5. Persists the epoch, root, and per-leaf proofs so agents can fetch their proof
   from `GET /v1/payouts` (a convenience; the same proofs are derivable from the
   on-chain `Settled.leaves`, so the API is never load-bearing — §12.1).

Because only `released` bonuses are ever reserved, the on-chain layer inherits
§14's honesty guarantee for free: a confabulated answer whose bonus is clawed
never reaches the chain, and its baseline (cost reimbursement) is the only thing
that flows — exactly the §14.2 payoff table.

---

## 6. End-to-end lifecycle with funding

This extends ARCHITECTURE.md §10. New steps are **bold**.

```
asker browser → /ask form → server action → INSERT questions (funding_state='unfunded')
                                                   │
                                                   ▼
                         ** /q/[id] shows "Fund this question" step **
                         ** asker: USDC.approve(escrow, stake) **
                         ** asker: escrow.fundQuestion(qid, stake, closesAt)  [asker pays gas] **
                                                   │
                         ** broker chain-watcher sees QuestionFunded **
                         ** broker UPDATE questions SET funding_state='funded', fund_tx=… **
                                                   │
                                                   ▼
                         GET /v1/questions/open  (now filtered: funding_state='funded')
                                                   │
                                                   ▼
                         Hermes skill answers → POST /v1/envelopes  (unchanged hot path)
                                                   │
                                                   ▼
                         broker.verify pipeline → INSERT envelopes + UPDATE aggregates
                         + write payout_entitlements (baseline; bonus 'escrowed')   [§14.2]
                                                   │
                         ** audit + override window resolves bonus → 'released'/'clawed' **
                                                   │
                         ** every epoch: broker settle(qid, amt, root, leaves) [leaves on-chain] **
                                                   │
                                                   ▼
                         ** agent: escrow.claim(cumulative, proof)  [agent pays gas, pulls funds] **
                                                   │
                         happy path: ** broker closeQuestion(qid) → asker refund(qid) (immediate) **
                         escape hatch: ** asker refund(qid) alone after closesAt + GRACE (broker not needed) **
```

The last two lines are the **trust-minimizing backstop**: the happy path lets the
asker reclaim leftover stake the moment the broker marks the question done, but if
the broker never does — or never comes back at all — the asker can reclaim the
unreserved remainder unilaterally once the settlement grace elapses, and agents
can still claim their already-settled balances from on-chain data (§12.1).

Two gates are new and important:

- **Funding gates dispatch, not visibility.** An unfunded question may still be
  visible on the web feed (labelled "awaiting funding"), but the broker's
  `GET /v1/questions/open` query adds `AND funding_state='funded'`, so agents
  never spend inference on a question nobody has paid for. This is the on-chain
  analog of VISION's "your question is funded and live."
- **The answer hot path is untouched.** Envelope submission, verification, and
  the boundary-leakage guarantees (ARCHITECTURE.md §12) are exactly as today. Payments are a
  separate, asynchronous settlement loop. There is **still no chain access at
  answer time** (§1.5) — the chain is touched only by the asker (funding), the
  broker's background watcher/settler, and the agent (claim).

---

## 7. Schema additions

Owned by `hearme-web`'s Drizzle migration (the schema is web's, ARCHITECTURE.md
§3), even where only the broker writes the column, to keep one canonical source.

**`questions` — funding state (orthogonal to `status`):**

```sql
ALTER TABLE questions
  ADD COLUMN funding_state  TEXT NOT NULL DEFAULT 'unfunded',  -- 'unfunded' | 'funded'
  ADD COLUMN funding_token  TEXT,            -- ERC-20 address asker funded with
  ADD COLUMN funding_amount NUMERIC,         -- stake, in token base units
  ADD COLUMN escrow_qid     TEXT,            -- bytes32 used on-chain (UUID → 0x… )
  ADD COLUMN fund_tx        TEXT,            -- funding tx hash (set by broker)
  ADD COLUMN funded_at      TIMESTAMPTZ,
  ADD CONSTRAINT questions_funding_state_chk CHECK (funding_state IN ('unfunded','funded'));
```

`status` (`open`/`closed`) keeps its current meaning (the time-box). A question
is answerable iff `status='open' AND funding_state='funded'`. `escrow_qid` is the
question UUID rendered as a `bytes32` — deterministic, no extra entropy needed.

**`registrations` — the agent payout address:**

```sql
ALTER TABLE registrations ADD COLUMN payout_address TEXT;  -- EVM address, broker-bound at registration
CREATE INDEX registrations_payout_address_idx ON registrations(payout_address);
```

**New broker-owned tables** (cursor + epoch ledger + cumulative balances):

```sql
-- One row per settle epoch; the published cumulative root and its tx.
CREATE TABLE payout_epochs (
  epoch         BIGINT PRIMARY KEY,
  merkle_root   TEXT NOT NULL,
  settle_tx     TEXT,
  total_settled NUMERIC NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Running per-agent cumulative owed, the input to each new root.
CREATE TABLE agent_cumulative_owed (
  payout_address TEXT PRIMARY KEY,
  cumulative     NUMERIC NOT NULL DEFAULT 0,
  last_epoch     BIGINT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-entitlement → epoch link, so each entitlement is reserved exactly once.
CREATE TABLE payout_reservations (
  question_id       UUID NOT NULL,
  unique_identifier TEXT NOT NULL,
  epoch             BIGINT NOT NULL REFERENCES payout_epochs(epoch),
  amount            NUMERIC NOT NULL,
  PRIMARY KEY (question_id, unique_identifier)   -- idempotency: one reservation per entitlement
);

-- Reuse the existing chain-cursor pattern (cf. self_chain_cursors) for the
-- Base-Sepolia funding listener.
CREATE TABLE escrow_chain_cursors (
  name       TEXT PRIMARY KEY,
  last_block BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Role grants** (`db/init/02-roles.sh`):

```sql
GRANT SELECT, INSERT, UPDATE ON payout_epochs           TO hearme_broker;
GRANT SELECT, INSERT, UPDATE ON agent_cumulative_owed   TO hearme_broker;
GRANT SELECT, INSERT         ON payout_reservations      TO hearme_broker;
GRANT SELECT, INSERT, UPDATE ON escrow_chain_cursors     TO hearme_broker;
-- broker already has SELECT, UPDATE on questions (README) — covers funding_state/fund_tx.
-- web writes funding_state='unfunded', funding_token, funding_amount, escrow_qid at creation
-- (web already has INSERT on questions); the broker flips funding_state to 'funded'.
```

The web role keeps writing only `questions`/`askers`; it sets the *intent*
(amount, token, escrow_qid, `funding_state='unfunded'`). The broker is the only
service that flips `funding_state='funded'`, having confirmed the deposit
on-chain — so the funded flag cannot be forged by the (un-authenticated, §11)
web client.

---

## 8. Service changes

### 8.1 `hearme-web`
- **`/ask`**: unchanged form, but `createQuestion` writes `funding_state='unfunded'`,
  the chosen `funding_token`, `funding_amount`, and the derived `escrow_qid`.
- **`/q/[id]` funding step**: when `funding_state='unfunded'` and the viewer is
  the asker, show a "Fund this question" panel: network (Base Sepolia), the
  escrow address, the amount, and a wallet connect + `approve` + `fundQuestion`
  button (wagmi/viem). Poll until the broker flips `funding_state='funded'`,
  then reveal the live question. *(Per the "deliver hearme UI work as a PR +
  preview" note, the funding-step UI ships as a separate PR with a rendered
  preview.)*
- Home feed labels unfunded questions and omits them from the default "open"
  list.

### 8.2 `hearme-broker`
- **`POST /v1/register`**: accept and atomically bind `payout_address` (mirrors
  the `agent_key` bind; reject conflicting rebind).
- **Funding watcher** (new background task, mirrors the existing Self-revocation
  listener): poll Base Sepolia for `QuestionFunded(qid, asker, amount, closesAt)`,
  confirm ≥ N confirmations, then `UPDATE questions SET funding_state='funded',
  fund_tx=…, funded_at=now()` for the matching `escrow_qid`. **Validate both**
  `amount ≥ funding_amount` **and** `closesAt == questions.closes_at`. The
  `closesAt` check is what makes the asker's on-chain refund deadline trustworthy:
  a question whose on-chain deadline disagrees with its DB close is *never*
  dispatched, so a manipulated deadline can only freeze the asker's own funds
  until they refund — it can never rug agents (none ever answer it).
- **Dispatch filter**: `GET /v1/questions/open` adds `AND funding_state='funded'`.
- **Settler** (new periodic task): the §5 loop — read unreserved released
  entitlements, update `agent_cumulative_owed`, build the root, call
  `settle(qid, amount, root, leaves)` with the operator key (publishing the
  epoch's leaves on-chain so claims survive broker death — §12.1), persist
  `payout_epochs` + `payout_reservations`.
- **`GET /v1/payouts/{payout_address}`** (new, read-only **convenience**):
  returns the agent's current `cumulative` and Merkle `proof` for the latest
  epoch so the skill can build `claim` without re-deriving the tree. **Not
  load-bearing** — the same proof is reconstructible from the on-chain
  `Settled.leaves`, so a down broker never blocks a claim (§12.1). Leaks nothing
  the chain doesn't already expose.
- **New config** (env, prefix `HEARME_BROKER_`): `BASE_RPC_URL`,
  `ESCROW_ADDRESS`, `ESCROW_TOKEN_ADDRESS`, `CHAIN_ID=84532`,
  `PAYOUT_OPERATOR_KEY` (the EVM secp256k1 operator key — KMS in prod, §13),
  `PAYOUT_EPOCH_SECONDS`, `FUNDING_CONFIRMATIONS`.

### 8.3 `hearme-skill`
- At install: generate a secp256k1 payout keypair, store the private key beside
  the Ed25519 agent key (§7.6 `crypto/`), include `payout_address` in the
  `EnrollmentBundle`.
- A small **claim** action (`ledger.py` / §7.7): periodically (or on user
  request) fetch the proof from `GET /v1/payouts/…` and submit `claim(...)` from
  the payout key. Surface "X test-USDC claimable" in the skill UI (§7.8). This
  is the *only* place the skill touches a chain, and it is off the answer path.

---

## 9. Privacy analysis

The non-negotiable is §1.4: linkability is *bounded and named* (broker-side),
and must **not** spill onto a public ledger. This section analyzes the
broker-built cumulative distributor (L0–L2). **Note:** the non-discretionary
endgame (§12.4) changes the payout mechanism, and a naive per-question
claim-by-proof would *regress* this privacy — the **required** privacy-preserving
realization is permissionless **pooled** claims with zk + scoped nullifiers,
specified in **§12.5**.

- **What the chain reveals:** `fundQuestion` reveals (asker address, qid,
  amount, closesAt). `Claimed` reveals (agent address, total claimed). `Settled`
  reveals (qid, amount-this-epoch, root) **plus the epoch's `(address,
  cumulative)` leaves as calldata** — see the tradeoff below.
- **What the chain does *not* reveal:** which agent answered **which question**;
  an agent's demographics; the Self nullifier; the per-question split. The
  asker→agent *bipartite* payment graph stays entirely off-chain in the broker's
  DB. This is the whole reason for choosing the Merkle distributor over a direct
  `reserve(agent, amount)` ledger.
- **Liveness↔privacy tradeoff (publishing leaves).** Making claims survive a dead
  broker (§12.1) requires the `(address, cumulative)` leaves to be available
  *without* the broker, so each `settle` publishes them as calldata. The cost is
  that the chain now exposes the **set of earner addresses and each one's running
  total** (not just those who have claimed), per epoch. It still does **not** tie
  any address to a question, a demographic, or a nullifier — the load-bearing
  privacy property holds. If even the earner-set leak is unacceptable, the
  fallback is to pin the leaves to IPFS/Arweave and put only the CID on-chain
  (cheaper, but reintroduces a pinning-liveness assumption); epoch-rotated
  addresses (below) shrink the leak either way.
- **Residual linkage:** the broker still holds `nullifier ↔ payout_address` and
  thus could, in principle, deanonymize an address. That is the *same* trusted
  linkage that already exists (§1.4 says the broker can link a user's answers);
  it is not newly created, and it stays off-chain. **Phase-2 hardening:**
  epoch-rotated payout addresses (a fresh address per payout epoch, registered
  via signed rotation), aligning with the epoch-rotated-scope upgrade already
  contemplated in §13 — this caps how much any single address accumulates and
  shortens the linkage window.
- **Asker exposure:** the asker's funding address is public and linkable to the
  question. For civic/whistleblower askers (VISION §5) this matters; a relayer
  or the eventual card→sponsored-wallet on-ramp (§10) removes it. Noted as a
  known limitation of the crypto-native funding path.

---

## 10. Relationship to the VISION "no wallet, no crypto" promise

VISION.md §"How It Works" promises askers pay **by card, no chain knowledge**,
with the stake "locked in a smart contract *under the hood*." This concept
builds the *under-the-hood* contract and exercises it with a **crypto-native
asker** on testnet — the necessary first layer. The card experience is then a
thin on-ramp on top: a custodial/relayer service takes the card payment and
calls `fundQuestion` on the asker's behalf. Nothing in `HearmeEscrow` changes;
only *who signs the funding transaction* does. Building the contract-first path
now lets us prove the settlement loop before adding fiat plumbing.

---

## 11. Security analysis / failure modes

| Threat | Mitigation |
|---|---|
| **Broker steals asker funds by self-dealing** | **The main residual trust *until §12.6*.** No code path moves a pool *directly* to the broker, but at L0 the broker picks the leaf recipients, so it can name its own addresses as "agents" and drain a funded pool (bounded by stake + the pre-refund window). **§12.6 closes this on-chain**: `setRoot` requires a zk proof that every new leaf is bound to a user-held `agent_signature` the operator cannot forge, so the broker can only allocate to real participants — the worst it can do reduces to *censorship* (omitting a real user), which is a §12.1 liveness problem, not theft. Today (L0) it is bounded by per-question stake caps, the asker refund, public leaves (detectability), and β≈0. |
| **Broker withholds (never settles) / dies forever** | Funds are never *stuck* (§12.1): after `closesAt + SETTLEMENT_GRACE` the asker reclaims the unreserved remainder with no broker involvement, and agents claim any already-settled balance from on-chain leaves. The irreducible residual is narrower — answers earned *but not yet settled* when the broker dies (the broker is the only party that knows the correct split). Bounded by the grace window; further mitigations: public audit of `Settled` vs. aggregates, a broker bond (§16). |
| **Agent double-claims** | Structurally impossible: `withdrawn` is monotonic, `claim` pays `cumulative − withdrawn` and reverts on a stale/replayed proof. |
| **Stale-root claim after a clawback** | `β` that is clawed is *never reserved*, so it never enters a root. A root only ever increases an agent's cumulative; the system never needs to *reduce* an on-chain balance, so there is no clawback-after-reserve race. (Clawbacks happen entirely in the off-chain escrow window, before reservation.) |
| **Forged "funded" flag by web client** | Only the broker (confirming the on-chain event) flips `funding_state='funded'`; web cannot. DB role grants enforce it. |
| **Payout-address hijack** | Atomic bind at registration; conflicting rebind rejected (`payout_address_already_bound`), mirroring the `agent_key` Sybil bind (§5). |
| **Reentrancy on claim/refund** | Pull pattern + checks-effects-interactions (state written before `transfer`); add `nonReentrant`. Standard. |
| **Over-settle a pool** | `require(funded − settled ≥ amount)` in `settle`; distributor solvency invariant (§4.3) enforced by the broker and backstopped by `transfer` reverting on insufficient balance. |
| **Operator key compromise** | Attacker could publish a malicious root (pay arbitrary agent addresses up to settled funds) but still cannot exceed `Σ settled` or touch unfunded pools, and cannot redirect to the broker (no such path). Key lives in KMS/HSM; rotation = redeploy/`setBroker`. Shares the §13 broker-signing-key open question. |
| **Front-running / MEV** | Claims are address-gated (`msg.sender`), so a front-runner cannot steal a claim. Funding is idempotent per qid. Minimal surface; negligible on testnet. |

---

## 12. Trust-minimizing the broker

Two distinct trust axes, addressed separately:

- **§12.1 Liveness** — can a *down* broker strand funds? (No.)
- **§12.2 Allocation correctness** — can a *dishonest* broker pay the wrong
  people (including itself)? (The main residual; here is the ladder that shrinks
  it.)

### 12.1 Liveness: funds can never be stuck (no broker dependency)

The first way to *reduce broker trust* is to ensure that **every party can get
the money it is owed without the broker's cooperation**, so a broker that goes
down — temporarily or forever — can delay payouts but never strand them. Two
escape hatches, one per side, achieve this:

**1. Asker escape hatch — unilateral refund after the grace.** Each pool stores
the question's `closesAt` (asker-supplied, broker-validated before the question
is ever dispatched — §8.2). After `closesAt + SETTLEMENT_GRACE`, the asker can
call `refund(qid)` themselves and reclaim the **unreserved remainder**
(`funded − settled`), with no `onlyBroker` gate and no `closed` flag required.
The happy path (`closeQuestion` → immediate refund) is *only an accelerator*; the
deadline arm is the guarantee. Once refunded, `funded` is set to `settled`, which
makes any later `settle` for that pool revert — so the broker cannot re-allocate
funds the asker has already taken back.

**2. Agent escape hatch — broker-independent claims.** A Merkle root is useless
without the leaf and proof, and those normally come from the broker's
`GET /v1/payouts`. To remove that dependency, **each `settle` publishes the
epoch's `(address, cumulative)` leaves on-chain as calldata** (`Settled.leaves`).
Anyone can replay those events, rebuild the tree, and produce their own inclusion
proof against the on-chain `root`. So an agent can `claim` everything in any
published root straight from chain data, even if the broker's API is gone
forever. (Privacy cost of publishing leaves is analyzed in §9.)

**Why this is safe for agents, not just askers.** The asker can only ever reclaim
the *unreserved* remainder; anything the broker already `settle`d is in the
distributor and is claimable by agents regardless of what the asker does. The
grace must therefore be **long enough that the broker can settle every answer
that beat `closesAt`**, including the §14 audit + override window during which a
bonus is still legitimately escrowed. So:

```
SETTLEMENT_GRACE  ≥  max audit/override window (§14.3/§14.5)
                  +  a few settle epochs (HEARME_BROKER_PAYOUT_EPOCH_SECONDS)
                  +  safety margin for broker maintenance/migration
```

A suggested default is **14 days**; it is a deploy-time constant.

**What remains irreducible.** If the broker dies *mid-window* — answers were
accepted but never settled — those specific agents are not paid, because the
broker is the only party that knows the correct split (who answered, who passed
audit, who was clawed). No on-chain mechanism can reconstruct that off-chain
judgement. This residual is **bounded by the grace window** (a dead broker stops
accepting new answers too, since dispatch needs it) and is the same "trust the
operator's honesty *while it is alive*" assumption Hearme already makes for
aggregation (§1.4). Shrinking it further — e.g. a broker bond slashable for
provable non-settlement, or a fallback settler — is listed in §16.

**Net effect on liveness:** the broker is demoted from *custodian and gatekeeper
of withdrawals* to *an allocator that must act within a bounded window or forfeit
its say*. Asker principal and already-earned agent balances are protected by the
contract, not by the broker staying up.

### 12.2 Allocation correctness: who can the broker pay?

§12.1 stops a *dead* broker from stranding funds. It does **not** stop a *live,
dishonest* broker from paying the **wrong** people. This is the largest residual
trust in the design and deserves to be named precisely.

**The attack.** `settle(qid, amount, root, leaves)` checks only that
`amount ≤ pool.funded − pool.settled`. It does **not** check *who* the leaves
pay. So the broker can publish a root whose leaves credit **its own addresses**,
move a funded question's stake into the distributor, and claim it. "In-contract
allocation" removed *direct* custody (no `transfer` to the broker), but the
broker still **chooses the recipients**, so it can self-deal up to a question's
stake within the pre-refund window. We must constrain *who counts as a payee*.

**What "correct" means.** A payout leaf `(address, amount)` is legitimate iff:

1. `address` is the `payout_address` of a **really-registered human** (one Self
   nullifier, §1.4) — not a broker-fabricated identity;
2. that human submitted **accepted answers** (valid `agent_signature` over real
   envelopes that passed the broker's verify pipeline, §5);
3. `amount` equals the **§14 schedule** for those answers — `baseline` per
   accepted envelope plus only the **released** `bonus`.

**Why a zk proof alone is necessary but not sufficient.** A SNARK proving "root
`R` was computed correctly from a registry commitment `Rg` and an accepted-
envelope commitment `Re`" is exactly the right shape — but it is only as honest
as `Rg` and `Re`. The strength of those inputs depends on **which broker you
distrust**, and the two cases differ sharply:

- **Honest broker *code*, untrusted *allocation decisions*.** If the deployed
  service faithfully runs its published verification, it **cannot fabricate
  agents**: `POST /v1/register` requires `self_proofs` that actually verify
  (SNARK + the on-chain Celo registry-root check, §5), production rejects mock
  proofs, and a Self proof needs a **real human to NFC-scan a real passport** and
  generate it on-device — bound to `userDefinedData = agent_key`, so a legit
  user's proof can't even be repurposed to the operator's payout key. Under this
  model every `Rg` leaf is a real, unique human, and L1/L2 genuinely close
  allocation correctness. **This is the case the identity requirement already
  covers** — exactly the point that the human must *actively provide* their
  identity for a registration to exist.
- **Byzantine *operator* (untrusted code execution).** The gap is not in the
  protocol but in *enforcement*: nothing **outside the broker's code** ties a
  `registrations` row to a real proof. The row is plain Postgres TEXT the broker
  `INSERT`s, and the Self proof is **verified once and discarded** (verify-once),
  leaving no portable, independently-checkable evidence. An operator running
  modified code — or writing the DB directly (it holds `INSERT` on
  `registrations`) — can fabricate `Rg`, and the proof faithfully certifies a
  fraudulent `R`. **zk then only moves the trust from "broker computes `R`
  honestly" to "the operator faithfully ran Self verification when it built
  `Rg`."**

**The trust floor is *verifiable* registration, not registration per se.** So the
floor is not "the broker can invent humans from nothing" — under honest code it
demonstrably can't. The floor is **trusting the operator's code execution**.
*Fully* removing allocation trust therefore requires registration evidence to be
**portable**: each `Rg` leaf carries a Self proof that anyone (or a circuit) can
re-check, so personhood holds without trusting the operator ran anything. Two
ways to get there — verify the Self proof **in-proof / on-chain** (L3), or run
the registration path in a **TEE with remote attestation** (lighter: attests
honest execution instead of re-proving it). Either anchors the same
one-passport→one-identity property §14.4 leans on (and the Celo read already in
§5).

**Irreducible residual even then.** An operator who controls **real distinct
passports** can register *those* and self-deal through them. That is bounded by
how many real passports it holds — the Sybil bound, indistinguishable from "real
humans colluding" — i.e. the §14.4 "personhood caps it" residual, not a protocol
bug. Verifiable registration collapses unbounded fabrication to this bounded,
universal residual.

**The decomposition that makes this tractable.** Reuse the §14.2 split:

- **Baseline `b` is mechanical** — every valid accepted envelope earns a fixed,
  public amount; **zero broker discretion**. This is exactly the part a proof can
  pin down end-to-end.
- **Bonus `β` is discretionary** — it depends on the audit + override oracle
  (§14.3/§14.5), which is inherently trusted and not fully provable. **But β is
  kept ≈0 in v0.3** (§14.8, §1 principle 4). So the un-provable surface is, by
  design, negligible until the §14.8 trust machinery exists.

**The ladder (increasing trust-minimization, increasing cost):**

| Rung | Mechanism | Removes | Still trusts | Fit |
|---|---|---|---|---|
| **L0** | today's draft + non-crypto bounds | direct custody | honest allocation | the as-written concept |
| **L1** | **optimistic**: broker commits `Re` (accepted-envelope root) on-chain; each payout leaf must reference it; a **challenge window** + **fraud proof** (show a leaf references a missing/duplicate/mis-priced/signature-invalid envelope) slashes a **broker bond** > max stake | honest *pricing & envelope-existence* (makes self-dealing negative-EV) | honest registration **code** — a Byzantine operator can still fabricate `Rg` | **recommended near-term**; reuses the §12.1 challenge-window pattern; no proving infra |
| **L2** | **validity (zk)**: SNARK proves `R = §14-function(Rg, Re)`; no window, instant finality, no watchers. **Concrete witness format spelled out in §12.6** (signature-attested allocation: every leaf bound to a user-held `agent_signature` the operator cannot forge → kills self-dealing) | the need to *watch*; computation integrity; **self-dealing** | honest registration **code execution** that built `Rg`/`Re` | when proving infra is worth it |
| **L3** | **verifiable registration**: re-check each `Rg` leaf's Self proof **in-circuit / on-chain**, *or* run registration in a **TEE with attestation**; + agent signatures verified in-proof | broker allocation trust **down to the §14.4 passport-collusion residual** | only the §14.5 override oracle (β, ≈0) + real-passport collusion (Sybil bound) | the endgame; rollup-grade (zk) or attestation-grade (TEE) |

**Non-crypto bounds that already cap the damage at L0 (so the rail is usable on
testnet while L1+ is built):**

- **Per-question stake cap** — a self-dealing broker can take at most one
  question's funded stake, not a pooled treasury (funds are per-pool until
  settled).
- **Settlement window + asker refund (§12.1)** — anything not settled before
  `closesAt + GRACE` returns to the asker, so the broker must steal *during* the
  window, in public.
- **Public leaves (§12.1) ⇒ detectability** — every payout set is on-chain;
  honest agents see they were omitted/underpaid and honest askers see implausible
  recipient sets. Fraud is visible and reputationally costly even before it is
  *provable*. A **broker bond** turns "visible" into "expensive."
- **β ≈ 0** — caps the *discretionary* (hardest-to-prove) component near zero.

**Recommendation.** Ship L0 with these bounds on testnet (Phase 1); add a
**broker bond + on-chain `Re` commitment + optimistic fraud proofs (L1)** before
any non-trivial value (Phase 2); treat **L2 (zk validity)** plus **L3 verifiable
registration (in-proof Self *or* a TEE-attested registration path)** as the
trust-minimization endgame that lets value and `β` scale (Phase 3, alongside
§14.8). State the assumption plainly at each rung: through L2 the residual is
**honest registration code execution** (not "the broker can invent humans" —
honest code can't), and L3 reduces even that to the §14.4 real-passport-collusion
residual. This is the same *class* of assumption as the honest-aggregation one
Hearme already documents (§1.4) — now bounded, detectable, bonded, and on a path
to provable.

### 12.3 Trust-minimization is also a *legal* simplification

The choice of rung is **not only "is the residual risk bounded?"** It is also
**"does the operator become a regulated financial intermediary, and does it have
to write contracts with its users?"** On that axis a *trusted* model can cost
*more* engineering than a trustless one — so trustlessness is not just a
security nicety to defer, it is a way to **avoid legal/operational machinery
entirely**.

**What triggers the burden is discretion + control over funds.** If the operator
*determines who gets compensated* and can move or withhold staked funds, it looks
like **custody / money transmission**: US state money-transmitter licenses, EU
PSD2 EMI/PI authorization, MiCA CASP/VASP registration — and, as importantly, a
**contractual relationship with every user**: custodial terms with askers (you
hold their stake), payee/compensation terms with agents (you decide their pay),
plus likely payee tax reporting and consumer-protection duties. "We promise to
allocate honestly" *is* the discretionary posture that attaches all of this.

**Removing discretion removes the category.** If payouts are a **deterministic,
verifiable function of objective inputs** — personhood proof + signed accepted
answer + a public payout schedule — enforced by the contract such that the
operator **cannot deviate**, then the operator is far more plausibly a
*software/infrastructure provider* than an intermediary: lighter custody/MTL
exposure, and **no bilateral user contracts to write**, because the autonomous
contract + published rules *are* the agreement (credible neutrality). The
asker-funds-the-contract, asker-self-refunds (§12.1), and agent-self-claims
(§12.1) pieces are *already* non-custodial; **the only discretionary chokepoint
left is allocation** (who the leaves pay) — which is exactly what §12.2 removes.

**This reframes the ladder: discretion is a *liability*, not merely a risk.**

- The operator must **never** be the discretionary determiner of payouts in a
  live, real-value system — even an "honest but discretionary" L0/L1 carries the
  heavy legal footprint while value flows.
- **L0 is acceptable on testnet only** (no real value, no real users ⇒ no real
  compliance surface). The architecture must be *ready* to be non-discretionary
  before mainnet value, so we never build ourselves into a custodial/discretionary
  posture we then have to unwind under regulatory pressure.
- The **baseline/β split makes it achievable now**: baseline is already a
  deterministic rule (verified human + valid signed answer ⇒ fixed amount), so it
  can be made operator-non-discretionary; β — the only genuine discretion — is
  ≈0. Push baseline to *the-rule-pays* and the operator's legal role collapses to
  relaying/proving.
- **Target architecture: claim-by-proof, not allocate-by-operator.** Agents
  redeem what the rules entitle them to by presenting proofs to the contract; the
  operator only publishes attestations it cannot forge or selectively withhold
  *without detection*. Withholding then degrades to a *liveness* problem (bounded
  by the §12.1 refund + bond), not a *discretionary-compensation* one.

**Honest limits (so this doesn't oversell).** Trustless ≠ zero legal exposure.
The **fiat on-ramp** (card → token, VISION §"How It Works") is regulated MSB
activity regardless and likely needs a licensed PSP partner — an argument *for*
the crypto-native asker path here, which sidesteps it for now (§10). Regulators
increasingly look through to deployers/beneficiaries; MiCA and OFAC
sanctions-screening can still apply; tax may still apply. This is not legal
advice and is jurisdiction-specific. But the *direction and magnitude* hold:
**removing operator discretion removes the single biggest, clearest category of
obligation**, which is why §12.2's endgame (L2/L3 + claim-by-proof) is a
first-class design goal, not a deferred luxury.

### 12.4 The non-discretionary flow at a glance

The whole target reduces to one inversion: stop the operator from *deciding who
gets paid and pushing money out*; instead let the **contract hold a fixed public
rule** and let **whoever can *prove* they qualify *pull* their payout**.

> **Cashier vs. vending machine.** A *cashier* takes the asker's money, looks at
> who answered, and *chooses* to pay them — you must trust the cashier and sign an
> agreement with them (→ custodian / money transmitter). A *vending machine* is
> *stocked* with money and a posted rule ("insert a valid token → out comes
> exactly `X`"); the owner stocked it but **cannot choose who it pays**, and no
> contract with the buyer is needed because the rule is visible and self-executing
> (→ infrastructure provider). The design turns the cashier into a vending machine.

**A baseline payout is owed iff three *facts* are true — and each is made provable
to the contract:**

1. **Personhood** — a real, unique human (the Self nullifier) ⇒ one payout per
   human per question.
2. **Work** — that human's agent submitted an answer the question **accepted**
   (valid signature, eligible, before close).
3. **Price** — a **fixed, public schedule** (baseline per accepted answer; β ≈ 0).

Payout `= rule(personhood, work, price)` — a pure function, no human judgment in
the disbursement.

```
   ASKER                OPERATOR (broker)              CONTRACT              AGENT
     │                        │                           │                   │
  1. fund a question ────────────────────────────────▶  pool[Q] = stake      │
     (deposit + post the      │                           │  + public rule    │
      public payout rule)     │                           │                   │
     │                  2. verify answers                 │            answer the Q
     │                     (the *service*) ◀──────────────────────── submit envelope
     │                        │                           │                   │
     │                  3. ATTEST, don't allocate:        │                   │
     │                     publish accepted-answer        │                   │
     │                     receipts on-chain (Re root) ─▶ Re committed        │
     │                        │                           │                   │
     │                        │                  4. CLAIM-BY-PROOF:           │
     │                        │                     "pay address A what    ◀──┤ present proof:
     │                        │                      Q's rule owes" ─────────▶ │  receipt ∈ Re
     │                        │                     contract checks proof      │  + personhood
     │                        │                     vs rule → pays from pool[Q]│  + signature
     │                        │                           │ ─────── pays ────▶ │
  5. refund leftover ◀───────────────────────────────── (permissionless,      │
     after close (§12.1)      │                           │  operator absent)  │
```

**Read the chart through the operator's role:** in step 4 the operator is *not in
the transaction* — the agent and the contract settle directly. The operator's
whole job shrinks to step 2 (run a verification *service*) and step 3 (publish
unforgeable, public *facts*). It never picks recipients and never touches funds.

> **This chart is the *trust* view, not the *privacy* realization.** Drawn
> literally — "pay address A what Q's rule owes → from `pool[Q]`" — it would link
> `address ↔ question` on-chain and leak which questions a user answered. The
> privacy-preserving realization (**required**, not optional) pools payment and
> uses zk + nullifier claims; see §12.5.

**Why this is precisely non-discretionary:**

- It **cannot pay itself or a fabricated address** — funds flow only to an address
  that can *prove* a real accepted answer; the operator can't mint that proof.
- It **cannot pay more** — the amount comes from the posted rule, not the
  operator's say-so.
- Its only residual lever is **refusing to attest a legit answer** — *censorship /
  withholding*, which is a **liveness** problem (detectable via the committed set,
  bounded by the asker refund, §12.1), **not** control over compensation. The
  operator still never holds or directs the money — the property that keeps it out
  of custody / money-transmitter classification (§12.3).

**The one knob that varies** is only *how rigorously each receipt is made
checkable* — the contract checks the math and one-claim-per-human trivially, but
"is this receipt backed by a real human + a real signed accepted answer?" is the
part that scales up the ladder: **optimistic L1** (publish receipts; fraud-prove a
fake/omitted one; slash the bond) → **validity L2/L3** (a proof that every receipt
is backed, so a bad set can't even be published). Same shape either way —
**claim-by-proof** — operator as *prover/relayer*, never *decider*.

### 12.5 Privacy of claim-by-proof — permissionless pooled claims (required)

Claim-by-proof (§12.4) and Hearme's core privacy promise (§1.4, §9 — the public
must never learn *which human answered which question*) are in tension, and
resolving it is **mandatory, not a nicety**. The naive realization is a privacy
**regression**, so the payout layer **must** use the construction below.

**Why the naive version leaks.** If a claim references question `Q` and is paid
from `pool[Q]`, the chain permanently records "address `A` answered `Q`" — exactly
the bipartite answer graph §9 keeps off-chain. Per-question pull ⇒ per-question
linkage. (The original §9 broker-built distributor avoided this by *aggregating
across questions* off-chain before publishing one cumulative root — but that
aggregation was the trusted/discretionary step we removed in §12.2–§12.4. So
removing operator discretion re-exposes per-question structure unless the claim
itself is made private.)

**The required construction: permissionless pooled claims.** Two properties
together restore §9's privacy while keeping the operator out of the claim path:

1. **Commingled pool.** Funds are paid from a **shared** pool, not from a
   per-question `pool[Q]`, so a claim debits no question-specific bucket. Per-
   question accountability is preserved *without identities* using public
   **counts**: `allocated[Q] = count[Q] × price` (where `count[Q]` = number of
   accepted answers, already public as the aggregate), and
   `refund[Q] = funded[Q] − allocated[Q]` returns to the asker (§12.1). The
   contract thus knows *how much* each question consumed, never *who*.
2. **zk membership + scoped nullifier claim.** The agent proves, in zero
   knowledge, "I hold an accepted-answer receipt committed in some funded
   question's `Re`, and I am a unique human" **without revealing which question or
   which leaf**, and reveals an opaque **claim nullifier** `= H(human, Q)` (or
   `H(human, epoch)`) so the contract can reject double-claims for that
   `(human, question)` pair without learning `Q`. This is the standard
   privacy-airdrop / Semaphore pattern: prove set-membership, reveal only a
   one-time-use tag.

```
  AGENT ──── zk proof { receipt ∈ Re(some funded Q), unique human }      CONTRACT
            + scoped nullifier  ──────────────────────────────────────▶  verify proof
                                                                          check nullifier unused
                                                                          pay `price` from POOL
            ◀───────────────────────────────────────────── pays ─────── mark nullifier used
  On-chain sees: "address A claimed `price` from the pool."  NOT which question.
```

So the answer to "can the user still hide which questions they answered?" is
**yes — and this construction is what makes it true.** Without it, claim-by-proof
would expose the answer graph.

**Residual leaks to mind even with pooled claims:**

- **Timing / amount correlation.** A burst of fixed-`price` claims right after a
  question closes narrows the anonymity set. Mitigate with **lazy, batched
  claims** (withdraw an accumulated lump across many questions, decorrelated from
  any one close — the cumulative habit from §12.1), **fixed denominations**, and
  randomized timing.
- **Use a scoped nullifier, never the raw Self nullifier.** Otherwise every claim
  by one human links to the others and to their identity (cf. the epoch-rotated
  scope in ARCHITECTURE §13).
- **`Re` leaves must be commitments, not plaintext `(address, Q)`** — else the
  published accepted-set *is* the answer graph. Leaves are opened only inside the
  zk proof.
- **Optimistic (L1) carries a privacy cost.** A fraud proof needs *data to
  challenge*, revealing receipt/envelope contents (and thus nullifier↔question
  links) on-chain; the validity-proof path (L2/L3) reveals nothing. So **privacy
  pulls toward L2/L3** — the same direction security (§12.2) and law (§12.3)
  already point. The optimistic interim should therefore challenge over
  *commitments* and be confined to the testnet/low-value window.
- **Asker side is unchanged** — funding is public (asker ↔ their own question),
  already noted in §9; that is the asker's privacy, and the question text is
  public regardless. Out of scope here (relayer / sponsored wallet, §10).

**Net:** permissionless pooled claims are the **required** payout mechanism for a
production system — they are what let the user keep "which questions did I answer"
private *and* keep the operator non-discretionary at the same time.

### 12.6 Signature-attested allocation proof — the concrete L2 realization

§12.2's ladder names L2 ("validity proof of `R = §14-function(Rg, Re)`") but does
not pin down the witness. The most consequential question — *what stops the
operator from putting its own addresses in the leaves?* — is answered by binding
**every allocation leaf to a user signature the operator cannot forge**, then
proving in zk that the new merkle root respects that binding. The contract
verifies the proof **before** accepting the new root. After this rung the broker
**can no longer self-deal**: it can allocate only to addresses for which it holds
real user signatures (it doesn't hold any for its own wallets), so the worst it
can do is **omit** real participants — pure censorship, not theft.

**What gets signed (no new user action required).** Every accepted envelope
already carries an `agent_signature` (ARCHITECTURE §5/§8.5):
`Sign(agent_key, H(question_id || answer || nonce || delegation_hash))`. The
agent_key lives **on the user's device** (in the skill — §7.6) and the broker
never holds the private key, so a signature attributable to a registered
agent_key is something only that user could have produced. This is the
"specific message the user signs" — and they sign it for every answer they give,
as part of normal operation. (Optional consent-clarity refinement: have the
skill additionally sign an explicit *per-epoch payout-authorization* message
that the circuit checks alongside the envelope signatures. Same crypto cost,
cleaner UX/semantics, easy to add later.)

**What the circuit proves.** Public inputs: prior root `R_prev`, new root `R`,
the committed accepted-envelope root `Re`, the epoch number, and the public
payout schedule (baseline + released-`β` set). Witness: the new envelopes (with
their `agent_signature`s), the `registrations` rows that bind each `agent_key`
to a `payout_address`, and the merkle update path from `R_prev` to `R`. The
circuit asserts, for **every** new leaf `(payout_address A, cumulative X)`
delta:

1. There exist accepted envelopes in `Re` whose `agent_signature` verifies
   under an `agent_key` that the witness `registrations` row binds to `A`.
2. The amount of `X − X_prev` equals the §14 schedule applied to *those*
   envelopes (count × baseline + only those `β` rows the public set marks
   `released`).
3. Nothing else in `R − R_prev` exists (no unaccounted-for leaves).

Without valid signatures for `A`, the operator literally **cannot** put `A` in
the proven root.

**Contract change (sketch).**

```solidity
function setRoot(
    bytes32  newRoot,
    bytes32  reCommitment,
    uint256  newEpoch,
    bytes    calldata proof
) external onlyBroker {
    require(newEpoch == epoch + 1, "epoch");
    verifier.verifyProof(proof, [bytes32(uint256(uint160(address(this)))),
                                 root, newRoot, reCommitment, bytes32(newEpoch)]);
    root  = newRoot;
    epoch = newEpoch;
    emit Settled(newEpoch, newRoot, reCommitment);
}
```

`onlyBroker` here is a **liveness convenience** (only the broker can post the
proof), not a trust knob — the proof is what enforces correctness. The verifier
contract is the standard Groth16 verifier (~230k gas, constant regardless of
how many allocations the proof covers).

**Trust analysis after §12.6.**

| | Before (today's draft) | After §12.6 |
|---|---|---|
| Broker self-deal (route stake to own addresses) | ✅ possible (the §11 main residual) | ❌ proof rejects — **closed** |
| Broker over-pay a legit user | ✅ possible | ❌ rule-bound, proven |
| Broker **omit** a legit user (censor) | ✅ possible | ✅ still possible — *liveness* problem; detectable (committed `Re` has the envelope, root doesn't), bounded by §12.1 refund + a §12.2 bond |
| Broker fabricate participants (Byzantine operator inserts fake `registrations` for keys it controls, signs from them) | ✅ possible | ✅ still possible — **the unchanged `Rg` residual**, only closed by L3 (verifiable registration / TEE) |

So §12.6 takes the broker from *"can steal up to a question's stake"* (today)
to *"can only censor + the `Rg` residual"* — a **dramatic** trust reduction
without paying L3's cost. Censorship is qualitatively different from theft: it
cannot redirect money, only delay/prevent it from reaching a real user, and a
real user denied a payout has *§12.1's asker-side refund* + a future *bond
slash* + a permanent **on-chain audit trail** (a committed envelope without a
matching root entry is provable).

**Proving cost — does this fit a normal computer?** Dominant cost per leaf:
one in-circuit signature verify + ~25 Poseidon hashes for the merkle path +
table lookups. With the *current* Ed25519 `agent_key`, ~30–40k constraints per
signature; with **EdDSA over Baby Jubjub** (SNARK-native), ~3–5k constraints per
signature. Per-epoch totals scale with **new allocations this epoch** (not
cumulative):

| New allocations / epoch | Constraints (Ed25519) | Constraints (BabyJubjub) | Prover, native (rapidsnark) | Prover, browser (WASM) |
|---|---|---|---|---|
| **10** | ~400k | ~80k | **1–3 s** | **30–60 s** |
| 100 | ~4M | ~800k | ~15–30 s | minutes |
| 1,000 | ~40M | ~8M | minutes (server) | impractical |
| 10,000 | needs Plonky2/Halo2 or recursive batching | | | |

For ~10 allocations/epoch — the realistic scale for early mainnet — **the proof
is a few seconds on a normal computer with rapidsnark**, well under a minute in
browser. For larger volumes the operator runs a server-class prover; one
practical pattern is **proof-per-question** (each question's allocations proven
independently, then aggregated). Contract verify is constant ~230k gas — *one of
the killer properties* of validity proofs: doubling allocations does not double
gas.

**Forward-compat: switch `agent_key` to EdDSA on Baby Jubjub.** ARCHITECTURE
§8.5 currently specifies Ed25519. Both are EdDSA variants and the migration is
mechanical (re-register), but it cuts per-signature proving cost ~10×. If §12.6
is on the mainnet path, schedule this in Phase 2 so Phase 3 deploys against the
cheaper curve. (Verification of standard Ed25519 in-circuit is feasible — the
table assumes it — so this is an optimization, not a blocker.)

**Privacy.** Preserves §9 — the chain still sees only the cumulative root, no
per-question split. §12.6 does **not** itself give §12.5's per-question hiding
(the operator still knows who answered what; the cumulative leaves still link
`address ↔ earnings`); for that, layer §12.5's permissionless pooled claims on
top of (or in place of) the operator-built root.

**Relationship to §12.5 (permissionless pooled claims).** They are
**complementary**, not alternatives:

- **§12.6 constrains *what the root can contain*** — operator-built, one proof
  per epoch, **no user-side proving**.
- **§12.5 changes *how users claim from it*** — pooled commingled pool, zk +
  scoped nullifier per claim, user-built proof per claim, hides which question.

A mature production stack uses **both**: §12.6 produces a constrained root the
operator cannot stuff with fakes; §12.5-style claims pull from it without
revealing which question. They compose cleanly because §12.6's correctness
property holds regardless of how the resulting balances are eventually claimed.

**Recommendation refinement.** §12.6 is the realistic **mainnet-critical** step:
it removes the largest concrete trust hole today (self-dealing), at constant
on-chain verify gas, with proving cost that fits a normal computer at realistic
volumes. Phase 3 in §15 should specify §12.6 (plus §12.5 for answerer privacy)
as the production allocation/claim layer; L3 verifiable registration tightens
the remaining `Rg` residual after that.

---

## 13. Testing posture (extends ARCHITECTURE.md §12)

- **Contract (Foundry/Hardhat):** fund→settle→claim→refund happy path; double
  claim reverts; over-settle reverts; non-broker `settle`/`closeQuestion`
  reverts; non-asker `fundQuestion` top-up and non-asker `refund` revert; Merkle
  proof for a non-leaf address reverts; solvency invariant property test (random
  fund/settle/claim sequences never let `Σ claimed > Σ settled`).
- **Liveness / escape hatches (the trust-minimization tests):**
  - asker `refund` **reverts before** `closesAt + GRACE` (when not `closed`) and
    **succeeds after** it with **no broker call** — the dead-broker asker hatch;
  - after a unilateral `refund`, a later `settle` for that pool **reverts**
    (asker can't be rugged back, broker can't double-spend the remainder);
  - an agent rebuilds a proof **purely from `Settled.leaves`** (broker API
    stubbed/offline) and `claim` succeeds — the dead-broker agent hatch;
  - `closeQuestion` only *accelerates* a refund that the deadline would allow
    anyway; it can never make `refund` pay anyone but `p.asker`.
- **Broker:** registration binds/forbids `payout_address` rebind; settler builds
  a root whose leaves match `agent_cumulative_owed` and publishes them on-chain;
  each entitlement reserved exactly once (`payout_reservations` PK); funding
  watcher flips `funding_state` only on a confirmed event with `amount ≥ intent`
  **and** `closesAt == questions.closes_at` (a deadline mismatch leaves it
  unfunded/undispatched); dispatch query excludes unfunded questions; **only
  released bonuses are reserved** (a `clawed` bonus never appears in any root).
- **Allocation correctness (§12.2):** once L1 lands — a payout leaf that
  references a **non-existent / duplicated / mis-priced / signature-invalid**
  envelope in the committed `Re` is rejected by the fraud-proof and slashes the
  bond; a **self-dealing settle** (leaves crediting a broker address with no
  backing envelope) is challengeable and unprofitable once the bond > stake. At
  L0, the test asserts only the *bounds*: a self-deal cannot exceed one pool's
  stake and is fully refundable to the asker after the grace.
- **End-to-end (`scripts/e2e.sh`):** add a local Base-Sepolia fork (anvil) +
  deployed `HearmeEscrow` + `MockUSDC`; asker funds, agent answers, broker
  settles, agent claims, asker refunds the remainder; **then a "broker goes
  dark" run**: kill the broker after a settle and assert the agent still claims
  and the asker still refunds the rest after the grace. Assert balances and that
  **no `Settled`/leaf reveals which agent answered which question** (privacy
  assertion, mirroring ARCHITECTURE.md §12's boundary-leakage assertion).

---

## 14. Parameters / glossary

| Symbol / field | Meaning |
|---|---|
| `b` (`baseline`) | §14.2 cost-reimbursement payout; low-risk; reserved early. |
| `β` (`bonus`) | §14.2 grounding bonus; at-risk; reserved only once `escrowed → released`. Kept ≈0 until §14.8 (§1, principle 4). |
| `escrow_qid` | Question UUID rendered as `bytes32` for on-chain keying. |
| `closesAt` | Question end timestamp, stored per pool; basis of the unilateral-refund deadline. |
| `SETTLEMENT_GRACE` | Window after `closesAt` before the asker can refund unilaterally; ≥ §14 audit/override window. Default 14 days (§12.1). |
| `cumulative` | Lifetime amount owed to a payout address; the Merkle leaf value. |
| `epoch` | One settle cycle; one published root + its on-chain leaves. |
| Operator key | Broker's EVM secp256k1 key = contract `broker` role; calls `settle`/`closeQuestion` (never moves funds to itself). Distinct from the Ed25519 token-signing key. |

---

## 15. Phasing / rollout

**Governing rule (§12.3):** real value must never ride on a *discretionary*
allocation model. The discretionary L0 path is **testnet-only**; mainnet value
requires the operator's allocation role to be non-discretionary
(claim-by-proof / verifiable settlement), to avoid the custody/money-transmission
and per-user-contract burden — not merely to bound theft risk.

1. **Phase 0 (today):** `payout_entitlements` recorded; no chain. *(done in v0)*
2. **Phase 1 (this concept):** deploy `HearmeEscrow` + `MockUSDC` on Base
   Sepolia; web funding step; broker funding-watcher + settler; skill payout key
   + claim. **Both escape hatches ship in Phase 1** (asker unilateral refund +
   on-chain leaf publishing) — they are core to the trust model, not an
   afterthought. Keep `β ≈ 0`. Prove the loop end-to-end on testnet, including a
   "broker goes dark" run.
3. **Phase 2 (trust-minimization + privacy hardening):** **allocation-correctness
   L1** (§12.2) — on-chain `Re` (accepted-envelope) commitment, payout leaves
   that reference it, optimistic challenge window + fraud proofs, and a **broker
   bond** > max stake slashable for a self-deal or non-settlement; epoch-rotated
   payout addresses; optional IPFS/Arweave leaf storage; card→sponsored-wallet
   on-ramp (§10). **Prepare for §12.6 by migrating `agent_key` from Ed25519 to
   EdDSA over Baby Jubjub** (~10× cheaper in-circuit) so Phase 3's prover is
   light.
4. **Phase 3 (mainnet + verifiable settlement):** **L2 via §12.6** — the
   signature-attested allocation proof, where every leaf is bound to a
   user-held `agent_signature` the operator cannot forge, and `setRoot` requires
   a Groth16 proof the contract verifies before accepting the new root. This
   **closes broker self-dealing on-chain** and reduces the residual to censorship
   (a §12.1 liveness problem) + the `Rg` registration trust. Layer **L3
   verifiable registration** (in-proof Self *or* TEE-attested) to close `Rg`, and
   **§12.5 permissionless pooled claims** for answerer-privacy (required so users
   can still hide which questions they answered). The operator now has *no*
   discretion over compensation (§12.3). Flip token to real USDC, chain to Base
   mainnet, operator key to KMS/HSM. Only with §12.6 + L3 + §14.8 (tiered
   vesting) in place can value and `β` rise safely (ARCHITECTURE.md §14.8 is
   explicit that raising `β` earlier re-opens the farming hole).

---

## 16. Open questions

- **Regulatory characterization (§12.3)** — at what point does discretionary
  allocation make the operator a money transmitter / custodian in the target
  jurisdictions, and what is the minimum non-discretionary design that avoids it
  (and the per-user contracts that come with it)? Drives *how soon* claim-by-proof
  is required, and whether any L0/L1 real-value window is permissible at all.
  Needs counsel; jurisdiction-specific.
- **Operator-key custody & rotation** — same unresolved question as the broker
  signing key (ARCHITECTURE.md §13); KMS vs HSM, rotation with an overlap window.
- **Payout-address rotation / lost key** — out of scope here; needs a signed
  rotation (old key authorizes new) without opening a hijack vector.
- **`SETTLEMENT_GRACE` sizing** — must dominate the §14 audit/override window so
  the unilateral refund can't reclaim funds an honest agent will still earn, yet
  be short enough that a dead broker doesn't lock asker principal for long. Fixed
  constant vs. per-question (longer questions → longer grace)? Default 14 days.
- **Residual: answers earned but unsettled when the broker dies** (§12.1) — bound
  it tighter than the grace with a slashable broker bond, or a permissionless
  fallback settler that can finalize a last published intent? Both undesigned.
- **Allocation-correctness depth (§12.2)** — how far up the L1→L3 ladder, and
  when? L1 (optimistic + bond) needs an on-chain `Re` commitment and an on-chain
  envelope/signature checker for the fraud proof (Ed25519 verification on EVM is
  non-trivial). L3 needs **verifiable registration** so a Byzantine operator
  can't fabricate `Rg` — either re-checking each leaf's Self proof in-circuit/
  on-chain, or a **TEE-attested registration path** (cheaper; attests execution
  rather than re-proving it). Which, and is trusting *registration-code
  execution* (the L1/L2 residual) acceptable given the §12.1 bounds + β≈0? What
  is the right `Re`/`Rg` commitment cadence and canonical leaf definition?
- **Bond sizing & griefing** — a broker bond must exceed the largest fundable
  stake to make self-dealing negative-EV, but an unbounded max stake implies an
  unbounded bond. Cap per-question stake, or scale the bond with open exposure?
- **`settle` granularity** — per-question calls (clean refund accounting) vs. a
  single `settleBatch(qids[], amounts[], root, leaves)` per epoch (one tx,
  cheaper). Likely batch, with per-qid amounts as calldata for refund math.
- **Stake sizing & overflow** — what if more eligible agents answer than the
  stake funds? Cap acceptance at the funded budget, first-come, or pro-rate the
  per-answer baseline? Interacts with `closes_at` and the §14 constants.
- **Leaf-publishing privacy vs. liveness** (§9) — accept the on-chain earner-set
  leak for broker-free claims, or move leaves to IPFS/Arweave (CID on-chain) and
  re-accept a pinning-liveness assumption?
- **Decimals / unit mapping** — fraction-of-a-cent payouts vs. 6-decimal USDC
  base units; ensure baseline `b` is representable without rounding to zero.
