# hearme-web

The Next.js App Router frontend for Hearme. See `/ARCHITECTURE.md` §4 for the
authoritative spec; this README only covers operational concerns.

This package is **the only writer of `questions` and `askers`**, and reads
public aggregate results for display. Raw envelopes and revocations remain
broker-private.

## Layout

```
packages/web/
├── drizzle/
│   └── schema.sql              # SINGLE SOURCE OF TRUTH (hand-authored SQL DDL)
├── scripts/codegen.mjs         # schema.sql -> schema.ts + Python row models
├── drizzle.config.ts
├── next.config.mjs
├── package.json
├── postcss.config.js
├── tailwind.config.ts
├── tsconfig.json
├── vitest.config.ts
├── tests/                      # vitest unit tests
└── src/
    ├── app/
    │   ├── layout.tsx
    │   ├── page.tsx            # GET  /         (list of open questions)
    │   ├── globals.css
    │   ├── ask/page.tsx        # GET  /ask      (new-question form)
    │   └── q/[id]/page.tsx     # GET  /q/[id]   (question detail)
    ├── actions/
    │   └── create-question.ts  # server action invoked from /ask
    ├── components/
    │   ├── ask-form.tsx
    │   ├── aggregate-chart.tsx
    │   ├── question-card.tsx
    │   └── question-detail.tsx
    └── db/
        ├── client.ts           # Drizzle client (reads DATABASE_URL)
        └── schema.ts           # GENERATED from drizzle/schema.sql (db:codegen)
```

## Run locally

Prerequisites: Node 20+, npm, and a running Postgres with the Hearme schema.
The repo-root `docker-compose.yml` provides one (`scripts/dev-up.sh` is the
convenience wrapper).

```bash
# 1. From the repo root: start postgres (this also auto-loads the schema
#    and creates the hearme_web / hearme_broker roles on first boot).
./scripts/dev-up.sh

# 2. Install + configure web.
cd packages/web
npm install
cp .env.example .env.local           # DATABASE_URL points at the local DB

# 3. (Re-)apply migrations against your DATABASE_URL.
#    For a fresh docker-compose volume this is a no-op — schema.sql was already
#    applied at container init. After a schema change (edit drizzle/schema.sql →
#    `npm run db:codegen`), re-run this to apply any hand-written deltas.
npm run db:migrate

# 4. Run the dev server.
npm run dev
```

Open <http://localhost:3000>.

### Database role

`DATABASE_URL` should point at a role that has:

- `SELECT, INSERT` on `questions` and `askers`
- `SELECT` on `aggregates`

The dev compose stack provisions a `hearme_web` role with exactly these grants
(see `db/init/02-roles.sh`). The web package only inserts into `questions`
and `askers` from the `createQuestion` server action; raw envelopes,
revocations, and aggregate writes are the broker's job and are explicitly
**denied** to the web role by Postgres.

We can't enforce role grants from inside this package — the role must be
granted by the DB admin (or in dev, by the compose init script). Code review
should reject any addition of `db.insert(envelopes)` / `db.insert(aggregates)`
in this package.

## Tests

```bash
npm test           # one-shot vitest run
npm run test:watch # watch mode
```

We currently cover:

- `tests/create-question.test.ts` — server-action validation (happy path
  + missing field + past `closes_at` + oversize text) and DB-insertion
  shape via a fake Drizzle handle.
- `tests/question-detail.test.tsx` — `<QuestionDetail/>` renders the
  predicate breakdown that comes from `aggregates.by_predicate` without
  exposing raw envelopes.

## Not yet real (v0 stubs)

The architecture (§11) lists the things v0 intentionally skips. The ones
that touch this package:

- **No auth.** `/ask` collects a free-text `display_name` and creates one
  display-only `askers` row per question. Display names are not stable
  identity; auth pages and account ownership land in v0.2.
- **No payments.** No payment fields in the schema or the UI. Asker
  micropayments are deferred to v0.3.
- **Polling instead of websockets.** `/q/[id]` and `/` both use Next.js
  `export const revalidate = 10` to refresh server-rendered data every ~10s.
  WebSocket / SSE push lands in v0.2.
- **No live revocation list rendering.** The `revocations` table exists for
  broker-side verification; the public UI does not read or render it.

Anything in this package that is a stub for a v0.2 capability is tagged with
a `// STUB:` comment in the source.

## What this package must never do

(Repeated from `ARCHITECTURE.md` §4 because it's easy to forget during a
feature sprint.)

- It must not write to `envelopes` or `aggregates`. Those are the broker's
  tables.
- It must not read or render raw envelopes; public pages consume aggregates.
- It must not talk to agents over HTTP. The frontend's only network peer is
  Postgres.
- It must not implement auth, payments, or asker accounts. Those are
  scheduled, not in v0.
