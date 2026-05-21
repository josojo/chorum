# hearme-self-bridge

> **Migration note.** This directory will be renamed `packages/self-bridge` when the
> code lands (see `SELF_MIGRATION.md`). It currently still reads `zkpassport-bridge`
> on disk; this README describes the **target** Self design that replaces it.

A small Node sidecar that wraps [`@selfxyz/core`](https://www.npmjs.com/package/@selfxyz/core)
(verification) and `@selfxyz/qrcode` / `SelfAppBuilder` (request creation).
It is the **only** component that creates and verifies real Self
zk-SNARK proofs. The Python broker and skill call it over HTTP because the
Self SDK is Node-only.

## Why it exists

Self proofs are verified with `@selfxyz/core`'s `SelfBackendVerifier`, which is
Node-only — there is no pure-Python verifier. So the broker delegates the
cryptographic check to this service while keeping all the structural/binding
checks (agent-key bind, scope, nullifier↔unique_identifier, predicate
re-derivation) in Python.

The SNARK check is **off-chain**: `SelfBackendVerifier` runs entirely on this
backend. To anchor that off-chain proof to the *real* Self registry (where
one-passport→one-identity is enforced), `/verify` **also** does a **one-time
on-chain read of Self's Celo Identity Registry at registration** — confirming the
proof's Merkle root is current/known and the identity is registered. This is the
only chain access in the system, and it never happens per answer. Trust
assumption: the proof is only as trustworthy as this bridge's pinned verification
keys plus that registry-root confirmation.

## Transport model (differs from zkPassport)

zkPassport relayed the finished proof back through its own request channel.
Self instead has the **mobile app POST the proof directly to the `endpoint`**
configured in the SelfApp. So this bridge *is* that endpoint: it exposes a
callback the Self app calls, verifies the submission, and stores the result for
the skill to poll.

## Endpoints

| Method | Path             | Used by | Purpose |
|--------|------------------|---------|---------|
| `GET`  | `/healthz`       | infra   | liveness + effective config |
| `POST` | `/requests`      | skill   | create Self request(s) bound to an agent key; returns QR/universal-link `urls` |
| `GET`  | `/requests/:id`  | skill   | poll for the relayed + verified proof(s); returns the verifiable `bundle`(s) |
| `POST` | `/callback`      | Self app| **the SelfApp `endpoint`** — receives a proof, verifies it, stores the result |
| `POST` | `/verify`        | broker  | verify a bundle (off-chain SNARK) **+ one-time on-chain Celo registry/root check** — **called once at registration** (`POST /v1/register`), never per envelope (Self proofs expire ±1 day; the broker issues its own session credential — ARCHITECTURE §5/§8) |

### `POST /requests`
```json
{ "agentKey": "<base64 Ed25519 pubkey>", "profile": "standard" }
```
→ `{ "requestId": "...", "urls": ["https://...", "..."] }`

Render each `url` as a QR in turn. The `standard` profile emits one request per
age threshold `[18, 25, 35, 50, 65]`, all under the same `scope` so they share
one nullifier (§8.3 of ARCHITECTURE.md). `minimal` emits only the `18+` request.
`agentKey` is set as `userDefinedData` (the in-proof agent-key bind).

### `GET /requests/:id`
→ `{ status, verified, uniqueIdentifier, disclosed, boundAgentKey, bundles }`
once all expected proofs are `complete`. Each `bundle =
{ attestationId, proof, publicSignals, userContextData }` is what the skill
puts in the `EnrollmentBundle.self_proofs[]` it sends to the broker's
`POST /v1/register`. `disclosed` carries the raw `nationality` and the
`olderThan` boolean per bundle; the broker buckets these into `region` /
`age_band` (it is authoritative).

### `POST /verify`
```json
{ "attestationId": 1, "proof": {...}, "publicSignals": [...], "userContextData": "0x..." }
```
→ `{ verified, uniqueIdentifier, disclosed, boundAgentKey, registryConfirmed }`.

A tampered `userContextData` (agent-key bind), wrong scope, expired proof
(±1 day), or invalid proof fails here. **`registryConfirmed`** is the on-chain
result: `true` only if the proof's Merkle root is a current/known root in Self's
Celo Identity Registry and the identity is registered (requires `SELF_CELO_RPC_URL`;
the broker rejects registration unless it is `true`). This `/verify` output is
consumed **once at registration** — the broker then mints the session credential,
and nothing here is re-checked per answer.

## Config (env)

| Var | Default | Meaning |
|-----|---------|---------|
| `SELF_SCOPE` | `hearme-v1` | application scope passed to `SelfAppBuilder` / `SelfBackendVerifier`; **part of the nullifier** (≤31 ASCII) |
| `SELF_ENDPOINT` | — | public URL of this bridge's `/callback`; must match the SelfApp `endpoint` |
| `SELF_ENDPOINT_TYPE` | `staging_https` | `staging_https` (testnet) or `https` (production) |
| `SELF_MOCK_PASSPORT` | `1` | `1` = staging/Celo Sepolia, accepts **mock-passport** proofs (testing); `0` = mainnet, requires a real passport |
| `SELF_CELO_RPC_URL` | — | Celo RPC endpoint for the **registration-time** on-chain Identity-Registry / Merkle-root check (Sepolia when `SELF_MOCK_PASSPORT=1`, mainnet when `0`). If unset, `registryConfirmed` is `false` and the broker rejects registration in production. Used **only** at `/verify` (registration), never per answer. |
| `SELF_ALLOWED_IDS` | `passport` | accepted attestation types (e.g. `passport`, `eu_id_card`) |
| `SELF_AGE_THRESHOLDS` | `18,25,35,50,65` | the `older-than` ladder for the `standard` profile |
| `PORT` | `8787` | HTTP port |

## Run

```sh
npm install
npm start            # node src/server.js
npm test             # node --test (network-free smoke tests)
```

> Pin `@selfxyz/core` (experimental SDK) and confirm the supported Node version
> during implementation.

## Testing without a real passport

Set `SELF_MOCK_PASSPORT=1` (staging). In the Self app, create a **mock passport**
(tap the passport button 5×) and scan the QR from `/requests`. Mock proofs verify
**only** in staging — flip `SELF_MOCK_PASSPORT=0` (mainnet) and the same proof is
rejected, which is the proof that real SNARK verification is in force.
