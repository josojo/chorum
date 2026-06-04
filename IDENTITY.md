# Hearme Identity Model — Self (self.xyz)

> Identity is the foundation of Hearme. Without a credible "one human, one voice" guarantee, every aggregate signal the platform produces is worthless.

> **Decision (2026-05):** Hearme's proof-of-personhood is built on **Self ([self.xyz](https://self.xyz))**, the single identity provider. An earlier design used **zkPassport**; we switched after weighing adoption and longevity (Self: 8–15M users, Google Cloud / Opera / Celo backing; zkPassport: niche, "not production-ready for critical apps" per Safe research) *and* confirming Self's SDK preserves Hearme's three non-negotiables — off-chain verification at answer time (the only chain read is a one-time registry check at registration), in-proof agent-key binding, and a stable per-scope nullifier. zkPassport is retained below only as **alternatives-considered** context. The concrete wire format and flow live in `ARCHITECTURE_V0.md` §8.

## The Problem

Hearme's political signal is only meaningful if each verified human counts once. Two failure modes are equally fatal:

1. **Sybil attacks** — a single actor (a bot farm, a state, a coordinated campaign) creates many identities and inflates a position they want amplified.
2. **Double counting** — a single honest user accidentally votes twice because the system treats different credentials (X, WorldCoin, email) as parallel voting rights.

Both fail for the same reason: if the *credential* is what grants a vote, anyone with multiple credentials gets multiple votes, and there is no way to deduplicate without linking identities (which destroys anonymity).

The fix is architectural: **the vote belongs to a Hearme identity, and a Hearme identity can only be created by presenting a unique-personhood proof at registration.** Other credentials (X, GitHub, ENS) can be attached later as reputation metadata, but they never create a new voting identity.

This document describes how **Self** is used as the unique-personhood proof that gates Hearme account creation (and why zkPassport was considered and dropped).


---

## Why Passport-Based Proof of Personhood

Modern biometric passports (ICAO 9303) contain an NFC chip with personal data signed by the issuing country's signing authority. The signature chain anchors to the country's Country Signing Certificate Authority (CSCA), whose public keys are published in the ICAO Public Key Directory.

This gives us, for free, a globally distributed proof-of-personhood infrastructure:

- ~1.4 billion biometric passports in circulation
- Issued by ~190 governments
- Cryptographically signed, tamper-evident
- Each passport is, by issuing-state policy, tied to one human

Combining this with zero-knowledge proofs lets a user prove "I hold a valid passport from country X, I am over 18, and here is a Hearme-scoped nullifier" — **without revealing the passport itself, the document number, or their name.**

Compared to the alternatives:

| Mechanism            | Coverage         | Privacy       | Vendor risk        | Regulatory risk            |
|----------------------|------------------|---------------|--------------------|----------------------------|
| WorldCoin (iris)     | Growing, gated   | Strong (ZK)   | Single vendor      | Banned/restricted in many countries |
| Humanity Protocol    | Early            | Strong        | Single vendor      | Unproven                   |
| Government KYC       | Universal-ish    | None          | KYC provider       | High (data leakage)        |
| Social vouching      | Limited          | Medium        | Distributed        | Vulnerable to coordinated attacks |
| **Passport + ZK**    | **~1.4B users**  | **Strong**    | **Open standard**  | **Low**                    |

Passport-based ZK is the strongest currently-deployable option for global coverage with reasonable privacy.


---

## Self (the chosen provider)

Self ([self.xyz](https://self.xyz), formerly OpenPassport, acquired by Self Labs in Feb 2025) is an open-source, passport-based identity protocol in the Celo ecosystem. The user scans their passport/ID NFC chip with the Self app and generates zk-SNARK proofs about its contents. As of 2026 it reports 8–15M users and is integrated by Google Cloud and Opera — the adoption and longevity that motivated the switch.

**What it proves:**
- The document is signed by a real CSCA in the ICAO directory and has not expired.
- Selectively disclosed attributes: nationality, an `older-than-N` age threshold, gender, OFAC sanctions non-membership — the user/app chooses which.
- A **scope-bound nullifier**: a deterministic, *unique-per-user-per-scope* value. Under Hearme's scope `"hearme-v1"` the same passport always yields the same nullifier, which is Hearme's `unique_identifier`.

**What it does not reveal:** passport number, name, photo, and — in Hearme's configuration — exact date of birth (we use age *thresholds*, never DOB; see below).

**Why Self clears Hearme's three non-negotiables:**

| Requirement | How Self satisfies it |
|---|---|
| **Off-chain verification at answer time** | `@selfxyz/core`'s `SelfBackendVerifier.verify()` runs on our Node backend (the self-bridge); per answer there is no chain access at all. The **one** on-chain dependency is a single Celo Identity-Registry read **at registration** (Sybil hardening, below). |
| **Bind the agent key into the proof** | `userDefinedData` (hex) carries the 32-byte Ed25519 agent key; the proof commits to it via `userContextData`. The broker checks the returned `userDefinedData` equals the bound agent key — a tampered binding fails verification. |
| **Stable per-scope unique identifier** | The nullifier is `unique-per-user-per-scope`; `scope="hearme-v1"` gives one stable identifier per passport across all Hearme answers. |

**How Hearme uses it (registration):**

1. User installs the Hearme skill; it generates an Ed25519 `agent_key`.
2. The self-bridge builds SelfApp request(s) — `scope="hearme-v1"`, `endpoint=<bridge callback>`, `userDefinedData=hex(agent_key)`, disclosures `{nationality, minimumAge}` — and returns universal-link/QR URLs.
3. User scans with the Self app, taps their passport. The Self app **POSTs the proof to the bridge endpoint** (Self's transport; the app calls your backend directly).
4. The skill posts the verified proofs (the **enrollment bundle**) to the broker's `POST /v1/register`. The broker runs `SelfBackendVerifier.verify()` via the bridge, checks the nullifier is unseen in Hearme's registry and that `userDefinedData == agent_key`.
5. If valid and unique, a Hearme identity is created, bound to the nullifier. Disclosed attributes are **bucketed** (below) into demographic metadata; raw values are not persisted. The broker then issues a **broker-signed session credential** (the `DelegationToken`) that the agent replays per answer — **the Self proof is verified once here and never again.** This is forced by Self's ±1 day proof-freshness window, and it means no raw proof or raw country crosses the boundary at answer time (ARCHITECTURE §1.2, §5, §8).

**Demographic disclosure — how Hearme reconstructs `age_band` and `region`.** Self has no native "5-year band" or "region" predicate, so Hearme derives both:

- **Region** ← disclosed `nationality` (ISO-3166 country) → mapped to `EU` / continent and **bucketed before storage**.
- **Age band** ← a **multi-threshold ladder**: at install the user runs several `older-than` proofs at thresholds `[18, 25, 35, 50, 65]`, all under `scope="hearme-v1"` so they share one nullifier. The set of passing thresholds reconstructs a band (e.g. `older_than(35)=T ∧ older_than(50)=F → "35-49"`). **Exact DOB is never disclosed.** Only the `18+` proof is required; the finer ones are optional (a user who skips them gets `age_band="18+"`).

The nullifier is the load-bearing piece: deterministic in `(passport, scope)`, so the same passport scanned twice produces the same nullifier — and Hearme rejects the second registration.

> **⚠️ The scope is FROZEN. Never change it in production.** Because the nullifier is deterministic in `(passport, scope)`, changing the scope gives *every existing user a brand-new identity*: Sybil resistance resets, every `registrations` row orphans, and every per-question voter tag stops matching — with **no migration path** (old nullifiers cannot be re-derived under a new scope). Production is pinned to `hearme-v1` **in code** (`packages/self-bridge/src/scope.js` → `PRODUCTION_SCOPE`): when `SELF_PRODUCTION_MODE=1` the bridge ignores any `SELF_SCOPE` env var, so a stray config change cannot silently re-mint identities. Staging uses a separate frozen scope (`staging-hearme-v1`) so its mock-passport identities never collide with mainnet. See `docs/DEPLOYMENT.md` §3.1 "Frozen constants — never change in prod" (GH #97).

**Testing without a real passport.** The Self app generates a mock passport (tap the passport button 5×). Mock proofs verify **only** with `SELF_MOCK_PASSPORT=1` (staging / Celo Sepolia + staging endpoints); flip it to `0` (mainnet) and the same mock proof is rejected — which is the proof that real SNARK verification is in force.


---

## Why a single provider (not zkPassport, and not both)

We deliberately ship **one** personhood provider.

**Why not zkPassport.** It was the prior choice (its nullifier mapped cleanly onto `unique_identifier` and `fast` mode verified locally). But it is niche — Safe's research calls it "not production-ready for critical applications" — and a small project being abandoned would break Hearme's identity layer. Self preserves the same three architectural wins while bringing materially more adoption, funding (Google Cloud / Opera / Celo), and document coverage.

**Why not run both.** Offering two providers reintroduces a cross-system Sybil hole: the *same passport* yields *different* nullifiers under different SDKs, so one person could register twice (once per provider). Closing that needs either a shared canonical nullifier derivation (cross-project coordination, not available today) or a single-provider-per-country rule (operational complexity). A single provider eliminates the hole by construction. If Self ever needs a fallback, the clean path is to add a second provider *together with* a shared `hash(DG1 || "hearme")`-style nullifier so both dedup against one registry — a roadmap item, not v0.


---

## What the Hearme Identity Looks Like After Registration

After successful passport verification, a Hearme identity consists of:

- **Nullifier** — the Self `unique-per-user-per-scope` identifier (scope `"hearme-v1"`). Used to prevent re-registration. Never displayed.
- **Demographic disclosures** — `region` (bucketed from disclosed nationality) and `age_band` (reconstructed from the older-than threshold ladder). Used for the regional/demographic breakdowns on aggregate results. Stored only in bucketed form; the raw country and the exact age are not persisted (DOB is never disclosed at all).
- **Reputation stamps** (optional, attached later) — X account, GitHub, ENS, Lens, prior Hearme participation. These never create new voting rights; they only feed a reputation score that may be displayed alongside aggregates or used for weighted sampling.
- **Agent binding** — the user's personal AI agent, authorized to answer on their behalf. Revocable.
- **Public key** — for signing votes and receiving payouts. The key is generated locally, never linked back to the passport.


---

## Limitations and Honest Caveats

1. **Not everyone has a biometric passport.** Coverage skews toward wealthier and more travel-active populations. Hearme's demographic breakdowns will reflect this skew until additional unique-personhood proofs (Aadhaar via Anon Aadhaar, national ID schemes, social-graph systems for the unbanked) are added.

2. **Passport sharing and coercion.** A passport can be physically borrowed, surrendered, or seized. ZK proofs cannot prevent a coerced user from scanning their own passport on someone else's behalf. MACI-style collusion resistance addresses *vote-time* coercion but not *registration-time* coercion. This is an open problem.

3. **Stolen passports.** A stolen passport with a known PIN-equivalent can register a Hearme identity for someone other than the rightful holder. The rate is low but nonzero; reporting and revocation mechanisms are needed.

4. **State-level attacks.** A government with control over its CSCA could issue fake passports and create fake Hearme identities at scale. Mitigations: monitor per-country registration rates, flag anomalies, optionally weight or cap per-country participation in any single question.

5. **Off-chain verification trusts the bridge — anchored by a registration-time on-chain check.** Self's `SelfBackendVerifier` SNARK-checks proofs off-chain. To stop a forged/stale Merkle root (which would let a fabricated identity slip through), at registration the broker also reads Self's **on-chain Celo Identity Registry once** to confirm the proof's root is current and the identity is registered (`SELF_CELO_RPC_URL` / `registryConfirmed`; ARCHITECTURE §5). Residual: this read happens only at registration, so a Celo-side revocation made *afterward* isn't reflected — Hearme's own `registrations` registry governs revocation from then on. The bridge's pinned verification keys and `@selfxyz/core` version remain trust-critical (a compromised/buggy bridge could accept bad proofs).

6. **Single-provider dependency.** With one provider, a Self outage or critical vulnerability stalls onboarding (steady-state answering is unaffected — the phone isn't a hot dependency, ARCHITECTURE §1.13). Adding a second provider is possible later but only with a shared nullifier derivation (see "Why a single provider").

7. **Minimization in transit — resolved.** Self discloses the *raw* nationality inside the proof. Because verification is **verify-once-at-registration** (ARCHITECTURE §5/§8), the raw proof (and raw country) reaches the broker only once at `/v1/register`, where it is bucketed to `region` and discarded; per answer, only the broker-issued credential travels. Residual: the broker *does* see the raw country that one time at enrollment — acceptable, and avoidable only by an in-circuit "in-EU" set-membership disclosure (a future option).

8. **Privacy of demographic disclosures.** Even age band + region can be deanonymizing in small populations. For low-population regions or rare demographic intersections, Hearme should aggregate or suppress breakdowns below a minimum cohort size.


---

## Open Questions

- Should Hearme require the same passport-scoped nullifier to be used across re-registrations (e.g., if a user loses their device), or accept a new nullifier from the same passport? The former is more Sybil-resistant; the latter is more user-friendly.
- How should expired-passport users be handled? Re-verify with the renewed passport? Allow a grace period?
- What is the right cohort-size threshold below which demographic breakdowns are suppressed?
- How are passport-less populations (~30% of humanity) brought in without weakening the Sybil guarantee for the rest?

These are questions for the next iteration of this document, not blockers for the initial design.
