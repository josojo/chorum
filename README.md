# hearme

v0 implementation of the system described in [ARCHITECTURE.md](./ARCHITECTURE.md).

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
├── db/
│   └── init/
│       └── 02-roles.sql         # role grants applied after schema
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
