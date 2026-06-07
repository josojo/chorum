# Privacy, retention & right-to-deletion

The engineering source-of-truth for Chorum's privacy commitments. The
user-facing copy lives at `/privacy` and `/terms` (rendered from
`packages/web/src/app/privacy` and `.../terms`); this file is the precise version
for operators and reviewers. Opened to close issue #104.

## 1. Data model recap (why deletion is even tractable)

- **Personhood, not identity.** Registration verifies a Self proof and stores a
  *nullifier* (a per-person pseudonym) plus coarse bucketed predicates. We never
  receive the passport, name, or document number. (`IDENTITY.md`)
- **Answers are unlinkable at source.** `envelopes.unique_identifier` is a
  per-question HMAC voter tag — `HMAC(linkage_secret, "hearme-voter-tag-v1" |
  question_id | nullifier)` — **not** the raw nullifier. The same person across
  two questions yields two unrelated tags, so the answers table alone is not a
  per-person history. Re-linkage requires *both* the `linkage_secret` (broker
  config / SSM, never in the DB) *and* the `registrations` nullifier list.
  (`ARCHITECTURE_V0.md §1.4`, ADR-098)
- **Nullifier-keyed PII tables** (broker DB only): `registrations`, `reputation`,
  `referrals`, `referral_codes`, `board_members`, `asker_admins`, and the
  nullable `askers.unique_identifier`.

## 2. Right-to-deletion flow

The registry is keyed by a nullifier that **only the user holds**, via their Self
app. So a deletion request is authenticated by *re-proving that same identity* —
there is no email/password to check. Two granularities:

### 2a. Retract a single answer — already shipped
`POST /v1/envelopes/revoke` (§1.12 "override is sacred"). The user signs a
revocation digest with their agent key; the broker deletes that one envelope and
rebuilds the question aggregate. Idempotent; allowed regardless of question
status.

### 2b. Delete the whole account — `POST /v1/account/delete`
`packages/broker/src/routes/account.ts`. Authenticated via
`verify/identityAuth.ts` — **either** the agent's 90-day `DelegationToken` **or**
a browser "Sign in with Self" asker session. Both resolve to the same nullifier.
The handler runs `queries.deleteAccount(nullifier)` in one transaction:

1. **Answers on still-live questions** are deleted. The broker recomputes the
   per-question voter tag from the nullifier + the live question secret, deletes
   the matching envelopes, and rebuilds each affected aggregate.
2. **Answers on already-closed questions** (secret destroyed past grace,
   ADR-098) **cannot be re-identified** and are left in place — they are
   irreversibly anonymous and no longer personal data. This is the honest
   definition of "deletion" the issue asked for.
3. **Every nullifier-keyed PII row is hard-deleted**: `registrations`,
   `reputation`, `board_members`, `asker_admins`, `referral_codes` (as referrer),
   `referrals` (as referee *or* referrer). Authored questions are kept but
   **unlinked** (`askers.unique_identifier` set NULL) — the public question text
   stays, detached from the person.
4. The live **`DelegationToken` is revoked** (`revocations`) so it can't outlive
   the account.

**Voluntary deletion ≠ Self on-chain invalidation.** An on-chain invalidation
(`invalidateRegistrationAndVotes`) *tombstones* the nullifier so it can never
re-register. A voluntary deletion leaves **no record of the nullifier**, so the
same human may freely return later with a fresh registration. Re-registration is
safe: voter tags are deterministic per `(question, person)`, so a returning user
still cannot double-answer a question they previously answered while it remains
open.

The endpoint returns a receipt with counts only — no identifiers.

## 3. IP handling policy

An IP is PII; we minimize it deliberately.

- **Resolution order** (`packages/web/src/lib/geo.ts`): `?loc=` override →
  edge geo headers (Vercel/Cloudflare/Fly — zero third-party call) → masked IP
  lookup → default. A deployment behind an edge provider leaks no IP at all.
- **Masking before third-party lookup.** When falling back to `ipwho.is`, the
  address is reduced to its network prefix first (IPv4 `/24`, IPv6 `/48`,
  `maskIp()`). Country geo is unchanged; the device-identifying host bits never
  leave our infra.
- **Disable entirely.** Set `HEARME_GEO_DISABLE_IP_LOOKUP=1` to drop the
  third-party lookup and rely only on edge headers + the default.
- **No raw IP in logs.** The broker's pino config
  (`packages/broker/src/logging.ts`) installs a `req` serializer that omits
  `remoteAddress`/`remotePort`. IPs are used transiently in-process (rate
  limiting, geo) and never written to the log stream.

### `ipwho.is` third-party flow
Free public IP-geolocation API, called server-side, **with a masked prefix
only**, results cached in-memory for 1h (never persisted). No account, no API
key, no PII beyond the masked prefix is shared. Before relying on it for EU
traffic at scale, confirm a DPA / sub-processor terms or self-host a geo DB
(e.g. MaxMind GeoLite2) — tracked as a follow-up.

## 4. Retention

| Data | Store | Retention |
|------|-------|-----------|
| Application logs (no raw IPs) | log backend | ≤ 30 days |
| Geo lookup results | in-memory cache | ≤ 1h, never on disk |
| Registration / answers | broker Postgres | until credential expiry, retraction, or account deletion |

## 5. Env knobs

- `HEARME_GEO_DISABLE_IP_LOOKUP=1` — skip the `ipwho.is` fallback (web).
- `NEXT_PUBLIC_PRIVACY_CONTACT` — contact address shown on `/privacy` and
  `/terms` (defaults to a placeholder; set per deployment).

## 6. Follow-ups

- Confirm a DPA / sub-processor agreement for `ipwho.is`, or self-host geo.
- Wire a user-facing "delete my account" button (the agent / asker UI) onto
  `POST /v1/account/delete`.
- Enforce the ≤30-day log retention at the log backend / box level.
