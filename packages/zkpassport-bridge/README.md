# hearme-zkpassport-bridge

A small Node sidecar that wraps [`@zkpassport/sdk`](https://www.npmjs.com/package/@zkpassport/sdk).
It is the **only** component that creates and verifies real zkPassport
(Noir / UltraHonk) proofs. The Python broker and skill call it over HTTP
because the SDK and its `@aztec/bb.js` verifier are Node-only.

## Why it exists

zkPassport proofs are UltraHonk and verified with Aztec's Barretenberg. There
is no pure-Python verifier, so the broker delegates the cryptographic check to
this service while keeping all the structural/binding checks in Python.

## Endpoints

| Method | Path             | Used by | Purpose |
|--------|------------------|---------|---------|
| `GET`  | `/healthz`       | infra   | liveness + effective config |
| `POST` | `/requests`      | skill   | create a zkPassport request bound to an agent key; returns the QR `url` |
| `GET`  | `/requests/:id`  | skill   | poll for the relayed proof; returns the verifiable `bundle` |
| `POST` | `/verify`        | broker  | stateless re-verification of a stored bundle |

### `POST /requests`
```json
{ "agentKey": "<base64 Ed25519 pubkey>", "profile": "eu-adult" }
```
→ `{ "requestId": "...", "url": "https://zkpassport.id/r?..." }`

Render `url` as a QR. The phone (a real passport, or a **mock passport** in
`devMode`) scans it; the proof is relayed back over the zkPassport bridge.

### `GET /requests/:id`
→ `{ status, verified, uniqueIdentifier, disclosed, bundle }` once
`status === "complete"`. `bundle = { version, proofs, query, queryResult, scope }`
is what the skill embeds in `DelegationToken.zkpassport_proof`.

### `POST /verify`
```json
{ "proofs": [...], "query": {...}, "queryResult": {...} }
```
→ `{ verified, uniqueIdentifier, disclosed, boundAgentKey, queryResultErrors }`.

`query` is the **original query** (it carries the `custom_data` agent-key bind).
A tampered query, or a proof bound to a different agent key, fails here.

## Config (env)

| Var | Default | Meaning |
|-----|---------|---------|
| `ZKPASSPORT_DOMAIN` | `hearme.network` | domain passed to `new ZKPassport()`; part of the nullifier |
| `ZKPASSPORT_SCOPE` | `v1` | request scope; part of the nullifier |
| `ZKPASSPORT_DEV_MODE` | `1` | `1` accepts **mock-passport** proofs (testing); `0` requires a real passport |
| `ZKPASSPORT_VALIDITY_SECONDS` | ~95 days | proof freshness window (must exceed the DelegationToken TTL) |
| `ZKPASSPORT_WRITING_DIR` | `/tmp` | where `@aztec/bb.js` writes CRS/artifacts during verify |
| `PORT` | `8787` | HTTP port |

## Run

Requires **Node >= 22** (a `@zkpassport/sdk` dependency uses ESM directory
imports unsupported on older Node).

```sh
npm install
npm start            # node src/server.js
npm test             # node --test (network-free smoke tests)
```

## Testing without a real passport

Set `ZKPASSPORT_DEV_MODE=1`. Install the zkPassport app, create a **mock
passport** (tap 5× on the passport button on the first screen), and scan the QR
from `/requests`. Mock-nullifier proofs verify **only** in dev mode — flip
`ZKPASSPORT_DEV_MODE=0` and the same proof is rejected, which is the proof that
real SNARK verification is in force.

> `@zkpassport/sdk` is experimental and unaudited — the version is pinned.
