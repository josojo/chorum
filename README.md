# hearme

v0 implementation of the system described in [ARCHITECTURE.md](./ARCHITECTURE.md).

**Identity:** proof-of-personhood is built on **Self** ([self.xyz](https://self.xyz)) — see [IDENTITY.md](./IDENTITY.md) for the why.

## Status

The v0 loop is implemented end-to-end: ask a question → an onboarded Hermes
agent answers it voluntarily on a cron schedule (using its own model, so all
inference cost stays with the bot-runner) → the broker verifies and aggregates →
the web app renders the result. Real Self proof-of-personhood is wired through
the `self-bridge` sidecar.

- [x] Shared Postgres schema + role grants
- [x] `packages/web` — Next.js frontend (ask form, question/aggregate pages, stats)
- [x] `packages/broker` — FastAPI dispatcher + verifier (`/v1/register`, `/v1/envelopes`, aggregates)
- [x] `packages/skill` — answering skill for Hermes **and** OpenClaw (shared core: cron answering, policy gate, envelope signing, onboarding)
- [x] `packages/self-bridge` — Node sidecar running `@selfxyz/core` (Self proof verification + QR onboarding)

Intentionally deferred (see [ARCHITECTURE.md §11](./ARCHITECTURE.md)): payments
(v0.3), the answer-integrity mechanism (§14), live revocation, encryption-at-rest,
multi-channel UI, and asker auth.

## Repo layout

```
hearme/
├── ARCHITECTURE.md
├── docker-compose.yml           # shared postgres for local dev
├── docker-compose.staging.yml   # public staging hardening overlay
├── db/
│   └── init/
│       └── 02-roles.sh          # role grants applied after schema
├── packages/
│   ├── web/
│   │   ├── src/db/schema.ts     # SINGLE SOURCE OF TRUTH for the schema
│   │   ├── drizzle/migrations/  # SQL generated from schema.ts (db:generate)
│   │   │   └── 0000_init.sql
│   │   ├── drizzle.config.ts
│   │   └── package.json
│   ├── broker/                  # FastAPI dispatcher + verifier
│   ├── skill/                   # answering skill (Hermes plugin + OpenClaw skill)
│   ├── self-bridge/             # Node sidecar for @selfxyz/core
│   └── proto/                   # JSON schemas for wire formats
│       ├── delegation.json
│       ├── enrollment.json
│       ├── envelope.json
│       ├── question.json
│       └── self.json
└── scripts/
    └── dev-up.sh                # bring up postgres
```

## Shared database

One Postgres instance, two writer roles (ARCHITECTURE.md §2, §4):

| role            | writes                                | reads     |
|-----------------|---------------------------------------|-----------|
| `hearme_web`    | `questions`, `askers`                 | all       |
| `hearme_broker` | `envelopes`, `aggregates`, `revocations` | all       |

`packages/web/src/db/schema.ts` is the **single source of truth** for the schema. The SQL migrations under `packages/web/drizzle/migrations/` are *generated* from it with `npm run db:generate` — never hand-edited. Extensions (pgcrypto) live in `db/init/00-extensions.sql` (drizzle-kit doesn't model extensions). CI (`npm run db:check`) fails if `schema.ts` has changes that weren't regenerated into a committed migration. To change the schema: edit `schema.ts`, run `npm run db:generate`, commit both.

### Bring it up

```sh
scripts/dev-up.sh
```

That starts `postgres:16` on `localhost:5432` with the schema and roles applied.

Connection strings for local dev:
- web    — `postgres://hearme_web:hearme_web_dev@localhost:5432/hearme`
- broker — `postgres://hearme_broker:hearme_broker_dev@localhost:5432/hearme`

### Staging secrets

Public staging must be started with the staging overlay, not the local-dev
defaults:

```sh
cp staging.env.example .env
# fill .env with random staging-only values
docker compose -f docker-compose.yml -f docker-compose.staging.yml config --quiet
docker compose -f docker-compose.yml -f docker-compose.staging.yml up -d --build
```

The overlay requires a non-dev broker signing key, non-dev Postgres passwords,
real Self identity mode (`SELF_MOCK_PASSPORT=0`, `SELF_DEV_MODE=0`), and broker
registry confirmation (`HEARME_BROKER_REQUIRE_REGISTRY_CONFIRMATION=1`).

### Reset the database

```sh
docker compose down -v && scripts/dev-up.sh
```

(`-v` drops the volume, so the init scripts re-run on the fresh data directory.)

### Verify the migration

```sh
scripts/verify-db.sh
```

Asserts the schema applied, both writer roles exist, the grant boundaries hold (web can't write envelopes, broker can't write questions), and the composite PK on envelopes rejects duplicate Sybil writes. This is the same check `.github/workflows/db.yml` runs in CI on every push and PR.
