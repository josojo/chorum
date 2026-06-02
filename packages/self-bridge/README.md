# hearme-self-bridge

A small Node sidecar that wraps [`@selfxyz/core`](https://www.npmjs.com/package/@selfxyz/core)
(verification) and `@selfxyz/qrcode` / `SelfAppBuilder` (request creation).
It is the **only** component that creates and verifies real Self
zk-SNARK proofs. The broker and skill call it over HTTP because the
Self SDK is Node-only.

## Why it exists

Self proofs are verified with `@selfxyz/core`'s `SelfBackendVerifier`, which is
Node-only — there is no pure-Python verifier. So the broker delegates the
cryptographic check to this service while keeping all the structural/binding
checks (agent-key bind, scope, nullifier↔unique_identifier, predicate
re-derivation) in the broker.

The SNARK check is **off-chain**, but `SelfBackendVerifier.verify()` **also does a
one-time on-chain read itself**: it queries Self's `IdentityVerificationHub` on
Celo (mainnet `forno` when `SELF_MOCK_PASSPORT=0`; Alfajores testnet + staging hub
when `1`), resolves the per-attestation `Registry`, and calls
`checkIdentityCommitmentRoot(root)`. If the proof's Merkle root is not live
on-chain, `verify()` throws. So a successful verify anchors the off-chain proof to
the *real* registry (where one-passport→one-identity is enforced) — the bridge
needs no extra `eth_call`, and reports `registryConfirmed: true` whenever the
proof verifies. This on-chain read happens only at registration, never per answer.
The bridge therefore needs outbound access to the Celo RPC. Trust assumption: the
proof is only as trustworthy as the SDK's pinned verification keys plus that
registry-root confirmation.

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
one nullifier (§8.3 of ARCHITECTURE_V0.md). `minimal` emits only the `18+` request.
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
(±1 day), an invalid proof, **or a Merkle root that isn't live in Self's Celo
Identity Registry** all fail here — `@selfxyz/core`'s `verify()` does the on-chain
root check itself and throws otherwise. **`registryConfirmed`** therefore mirrors
`verified`: a proof that verifies has necessarily been confirmed against the real
on-chain registry. The broker rejects registration unless it is `true`. This
`/verify` output is consumed **once at registration** — the broker then mints the
session credential, and nothing here is re-checked per answer.

## Config (env)

| Var | Default | Meaning |
|-----|---------|---------|
| `SELF_SCOPE` | `hearme-v1` | application scope passed to `SelfAppBuilder` / `SelfBackendVerifier`; **part of the nullifier** (≤31 ASCII) |
| `SELF_ENDPOINT` | — | **required, no default.** Public URL of this bridge's `/callback`; must match the SelfApp `endpoint`. **Must not be `localhost`/`127.0.0.1`** — `SelfAppBuilder` rejects those; use an ngrok https URL in dev. `/requests` returns a clear error (and startup logs a warning) if it is missing or localhost. |
| `SELF_ENDPOINT_TYPE` | `staging_https` | `staging_https` (testnet) or `https` (production) |
| `SELF_MOCK_PASSPORT` | `1` | `1` = staging: accepts **mock-passport** proofs; `verify()` checks the root against the Alfajores testnet + staging hub. `0` = mainnet: requires a real passport; checks against the mainnet hub. (The Celo RPC URL and registry address are managed by `@selfxyz/core` itself — there is no env knob for them.) |
| `SELF_DEV_MODE` | = `SELF_MOCK_PASSPORT` | Sets the SelfApp `devMode`. **Required `true` for the Self app to accept a MOCK passport** — `SelfAppBuilder` defaults it `false` (production), which silently makes a mock scan fail. Defaults to the mock-passport setting; override to force. |
| `SELF_CHAIN_ID` | _(sdk default)_ | Optional `chainID` override for the SelfApp. With `endpointType=staging_https` the SDK defaults to `42220` (Celo **mainnet**), which is wrong for a mock passport. If a mock scan fails on a network/root mismatch, pin the testnet the deployed `@selfxyz/core` checks: Celo Alfajores `44787` or Celo Sepolia `11142220`. |
| `SELF_ALLOWED_IDS` | `passport` | accepted attestation types (e.g. `passport`, `eu_id_card`) |
| `SELF_AGE_THRESHOLDS` | `18,25,35,50,65` | the `older-than` ladder for the `standard` profile |
| `PORT` | `8787` | HTTP port |

## Run

```sh
npm install
npm start            # node src/server.js
npm test             # node --test (network-free smoke tests)
```

> Verified against `@selfxyz/core@1.0.8` + `@selfxyz/qrcode@1.0.24`. Note
> `@selfxyz/qrcode` declares `engines.node ">=22 <23"` — run on Node 22 (it loads
> on 20 with an `EBADENGINE` warning, but that is unsupported).

## Testing without a real passport

Set `SELF_MOCK_PASSPORT=1` (staging) **and** `SELF_DEV_MODE=1` (so the QR is built
with `devMode:true` — without it the Self app treats the request as production and
will not offer/accept a mock passport). In the Self app, create a **mock passport**
(tap the passport button 5×) and scan the QR from `/requests`. Mock proofs verify
**only** in staging — flip `SELF_MOCK_PASSPORT=0` (mainnet) and the same proof is
rejected, which is the proof that real SNARK verification is in force.

If the scan still fails on a network/root mismatch, the SelfApp `chainID` is likely
pointing at mainnet (`42220`) while the mock identity lives on a testnet — set
`SELF_CHAIN_ID` to the testnet the deployed `@selfxyz/core` checks (Alfajores
`44787` or Sepolia `11142220`). Confirm what the bridge is emitting via
`GET /healthz` (now reports `devMode` and `chainID`) or by decoding the `selfApp`
param in a `/requests` link.
