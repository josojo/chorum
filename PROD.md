# hearme prod — quick reference

This file is local to your working tree (untracked) — feel free to commit it or
keep it private.

## Live URLs

| Service     | URL                                                                                          | Notes                                              |
| ----------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Web         | https://3-74-46-46.sslip.io                                                                  | Caddy auto-TLS via Let's Encrypt; http→https 308   |
| Broker      | http://3.74.46.46:8000 — `/healthz`, `/v1/questions/open`, `/v1/register`, `/v1/envelopes`   | direct, NOT behind Caddy                           |
| Self-bridge | https://3-74-46-46.sslip.io/self/\* (or http://3.74.46.46:8787 direct)                       | Caddy strips the `/self` prefix when proxying      |

Quick health checks:

```sh
curl -sS https://3-74-46-46.sslip.io/self/healthz
# {"ok":true,"scope":"hearme-v1","mockPassport":false,"devMode":false,
#  "chainID":42220,"registryCheck":true,"endpointOk":true}

curl -sS http://3.74.46.46:8000/healthz                # {"status":"ok"}
curl -sS http://3.74.46.46:8000/v1/questions/open      # [] until someone asks one
```

## Onboarding from the local skill (real Self / mainnet)

```sh
hearme-skill onboard \
  --bridge-url http://3.74.46.46:8787 \
  --broker-url http://3.74.46.46:8000
```

The skill is on your laptop with no public address, so it **polls the bridge**
at `GET /requests/:id`. The Self app POSTs the proof to the bridge's public
HTTPS endpoint (`https://3-74-46-46.sslip.io/self/callback`) — that URL is
baked into each QR by the bridge when it builds the `SelfApp`. The skill and
the bridge share state (same container process) regardless of whether the skill
hits :8787 directly or via Caddy.

## SSH into the prod box

```sh
ssh -i ~/.ssh/hearme-prod.pem ubuntu@3.74.46.46
```

- Username: `ubuntu`
- Key: `~/.ssh/hearme-prod.pem` (ed25519, generated 2026-05-28; fingerprint
  `L0Xr+NP68/9tR7nUQ3HDX+hkd0jmtGt6pei2f8XkREo=`)
- SSH ingress is restricted to `79.200.144.9/32` (your home IP at provision
  time). If you change networks you'll get `Connection timed out` — add the new
  source IP via:
  ```sh
  aws ec2 authorize-security-group-ingress --region eu-central-1 \
    --group-id sg-07452d9834eaa577c \
    --ip-permissions 'IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=<NEW_IP>/32,Description=admin-ssh}]'
  ```

## AWS bits (eu-central-1)

| Resource         | Identifier                                                       |
| ---------------- | ---------------------------------------------------------------- |
| Account          | `608325783191` (IAM user `hearme-staging` — Free-Tier-only policy) |
| Instance         | `i-0f90b3186aa47f2dd` (t3.small, Ubuntu 22.04, 30 GB gp3 + 6 GB swap) |
| Public IP        | `3.74.46.46` (NOT an Elastic IP — changes if the box is stopped) |
| Security group   | `sg-07452d9834eaa577c` (`hearme-prod`)                           |
| Key pair         | `hearme-prod`                                                    |
| VPC / Subnet / AZ | `vpc-0a8f46d724c65a2fd` / `subnet-030e7d8dd007222e6` / `eu-central-1b` |

Ports open at the SG: 22 (admin IP only), 80, 443, 8000, 8787 → 0.0.0.0/0.
Port 5432 is bound on the host but NOT open at the SG — only reachable from the
box itself.

## Updating prod

The prod-specific configs live ON THE BOX ONLY (NOT in this repo):
`~/hearme/.env`, `~/hearme/docker-compose.override.yml`, `~/hearme/Caddyfile`,
`~/hearme/db/init.prod/`. A `git pull` leaves them in place.

```sh
ssh -i ~/.ssh/hearme-prod.pem ubuntu@3.74.46.46
cd ~/hearme
git pull
docker compose up --build -d --remove-orphans
```

Wipe DB and start over (PROD — destroys all answers):

```sh
docker compose down -v && docker compose up --build -d
```

## What makes this prod (vs staging)

- `SELF_MOCK_PASSPORT=0`, `SELF_DEV_MODE=0`, `SELF_ENDPOINT_TYPE=https`,
  `SELF_CHAIN_ID=42220` (Celo mainnet), `SELF_CELO_RPC_URL=https://forno.celo.org`.
- `HEARME_BROKER_REQUIRE_REGISTRY_CONFIRMATION=1` (Sybil gate on),
  `HEARME_BROKER_EXPOSE_REJECTION_REASONS=0`,
  `HEARME_BROKER_DEV_INSECURE_REGISTER=0` (phone-free `/v1/dev/register` ⇒ 404).
- Fresh 32-byte Ed25519 broker signing key + fresh random DB passwords.
- DB seed file shadowed by a no-op; the system comes up with zero rows in
  `askers`, `questions`, `envelopes`, `aggregates`, `registrations`.
