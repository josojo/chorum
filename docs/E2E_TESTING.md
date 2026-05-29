# End-to-end testing with mock identities

Two ways to exercise the full answer → broker → aggregate pipeline:

- **A. Phone-free dev bypass** — fully automated, no Self app. Mints
  DelegationTokens for synthetic identities so you can populate aggregates at
  volume. Bypasses Self proof-of-personhood (everything else is real).
- **B. Real Self mock passport** — a genuine Self proof on the staging/testnet
  hub, scanned once per identity with the Self app. Proves the Self integration.

---

## A. Phone-free dev bypass

The broker mounts `POST /v1/dev/register` **only** when
`HEARME_BROKER_DEV_INSECURE_REGISTER=1`. It mints a broker-signed
DelegationToken for a synthetic nullifier + nationality/age without any Self
proof. Real Ed25519 keys, real signed envelopes, real eligibility + aggregate
logic — only the personhood check is skipped. **Never enable in production.**

```sh
# 1. Postgres (initialises schema + roles + demo seed on first run)
docker compose up -d postgres

# 2. Broker with the bypass enabled (local venv; or add the env to the broker
#    service and `docker compose up -d broker`)
cd packages/broker
HEARME_BROKER_DEV_INSECURE_REGISTER=1 \
HEARME_BROKER_DATABASE_URL="postgres://hearme_broker:hearme_broker_dev@localhost:5432/hearme" \
  .venv/bin/uvicorn hearme_broker.main:app --host 127.0.0.1 --port 8000

# 3. Create N synthetic identities and answer every eligible open question
packages/skill/.venv/bin/python scripts/dev-seed-identities.py \
  --broker-url http://127.0.0.1:8000 --n 40

# 4. See the result
curl -s http://127.0.0.1:8000/v1/stats        # site-wide counts
docker compose up -d web                       # http://localhost:3000 — aggregates per question
```

`scope_ineligible` rejections are expected: a question is scoped
(worldwide / continent / country) and an identity can only answer questions
matching its region/country.

---

## B. Real Self mock passport (isolated dev/testnet)

A Self **mock passport** is a feature of the Self mobile app on the
staging/testnet hub. There is **no phone-free way** to mint a real Self proof —
the zk proof is generated on-device — so each mock passport = one identity, and
you need the Self app on a phone. Do this on a local or isolated testnet stack;
the public staging overlay disables mock passports and dev mode.

### One-time: the bridge must request `devMode:true`

`SelfAppBuilder` defaults `devMode:false` (production), so a mock-passport scan
silently fails. The bridge now sets `devMode` from `SELF_DEV_MODE` (which
defaults to `SELF_MOCK_PASSPORT`). Confirm what a bridge is emitting:

```sh
curl -s https://<test-host>/self/healthz   # expect mockPassport:true, devMode:true
```

Redeploy the isolated testnet stack with the fix:

```sh
cd ~/hearme && git pull && docker compose up --build -d self-bridge
curl -s http://localhost:8787/healthz                 # devMode:true
```

### Scan + answer

```sh
# From the machine running your Hermes agent / skill:
hearme-skill onboard \
  --bridge-url http://<test-host>:8787 \
  --broker-url http://<test-host>:8000
# Scan each QR with the Self app (create a mock passport: tap the passport 5×).
# On success a DelegationToken is stored; the agent can now answer.
```

### If the scan fails on a network/root mismatch

The SelfApp `chainID` is likely `42220` (Celo mainnet) while the mock identity
lives on a testnet. Pin the chain the deployed `@selfxyz/core` checks via
`SELF_CHAIN_ID` on the bridge (Celo Alfajores `44787` or Sepolia `11142220`),
redeploy, and re-scan. `GET /healthz` reports the active `chainID`.
