# hearme

v0 implementation of the system described in [ARCHITECTURE.md](./ARCHITECTURE.md).

**Identity:** proof-of-personhood is built on **Self** ([self.xyz](https://self.xyz)) — see [IDENTITY.md](./IDENTITY.md) for the why and [SELF_MIGRATION.md](./SELF_MIGRATION.md) for the zkPassport→Self code-migration plan.

## Status

- [x] Shared Postgres schema + role grants (this commit)
- [ ] `packages/web` — Next.js frontend
- [ ] `packages/broker` — FastAPI dispatcher + verifier
- [ ] `packages/skill` — Hermes skill

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
│   │   ├── drizzle/
│   │   │   └── 0000_init.sql    # canonical schema migration
│   │   ├── src/db/schema.ts     # Drizzle TS mirror
│   │   ├── drizzle.config.ts
│   │   └── package.json
│   ├── broker/                  # (not yet created)
│   ├── skill/                   # (not yet created)
│   └── proto/                   # JSON schemas for wire formats
│       ├── delegation.json
│       ├── envelope.json
│       └── question.json
└── scripts/
    └── dev-up.sh                # bring up postgres
```

## Shared database

One Postgres instance, two writer roles (ARCHITECTURE.md §2, §4):

| role            | writes                                | reads     |
|-----------------|---------------------------------------|-----------|
| `hearme_web`    | `questions`, `askers`                 | all       |
| `hearme_broker` | `envelopes`, `aggregates`, `revocations` | all       |

The schema is owned by `packages/web/drizzle/0000_init.sql`. The Drizzle TypeScript schema in `packages/web/src/db/schema.ts` is a hand-mirror — keep both in sync until codegen is set up.

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
