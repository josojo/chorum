# hearme-classifier

Background TypeScript worker that assigns a topic to each new question in the
hearme broker DB by asking a cheap OpenRouter LLM (default
`google/gemini-2.5-flash-lite`). The broker only serves questions whose topic
has been set, so this service is the gate between "asker just posted" and
"agent is allowed to see it."

## Why this exists

If askers picked the topic themselves, someone asking
"Is metformin worth the side effects?" could just label it `ai` and slip past
the skill's `auto_answer_topics` privacy filter (see
`packages/skill/src/hearme_skill/policy.py`). The classifier makes the topic
asker-INDEPENDENT, picking 1–3 tokens from a fixed taxonomy
(`packages/proto/topics.json`) based on the question text alone.

## Architecture

- One Node process. Polls Postgres on a fixed interval; no message bus.
- DB role: `hearme_classifier` — column-level `UPDATE(topic)` on `questions`,
  plus `SELECT`. Nothing else (see `db/init/02-roles.sh`). A credential leak
  can only mislabel topics; it cannot read envelopes or registrations, and it
  cannot edit any other question column.
- LLM call: synchronous chat completion at temperature 0 in JSON mode. The
  reply is parsed against the taxonomy and any out-of-set token is dropped.
- **Fail-closed**: if the LLM call errors, returns non-JSON, or no taxonomy
  token survives normalisation, the row's topic stays NULL. The broker's
  `list_open_questions` excludes NULL-topic rows, so unclassified questions
  are simply invisible to agents until the next tick succeeds.

## Configuration

| env var                              | required | default                          | notes                                 |
|--------------------------------------|----------|----------------------------------|---------------------------------------|
| `HEARME_CLASSIFIER_DATABASE_URL`     | yes      | —                                | postgres-js DSN, `hearme_classifier`. |
| `HEARME_CLASSIFIER_OPENROUTER_API_KEY` | yes    | —                                | OpenRouter key.                       |
| `HEARME_CLASSIFIER_MODEL`            | no       | `google/gemini-2.5-flash-lite`   | OpenRouter model slug.                |
| `HEARME_CLASSIFIER_POLL_INTERVAL_MS` | no       | `10000`                          | Tick cadence.                         |
| `HEARME_CLASSIFIER_BATCH_SIZE`       | no       | `20`                             | Max rows per tick.                    |
| `HEARME_CLASSIFIER_ONE_SHOT`         | no       | `0`                              | `1` → exit after one tick.            |
| `HEARME_CLASSIFIER_LOG_LEVEL`        | no       | `info`                           | `debug` / `info` / `warn` / `error`.  |
| `HEARME_CLASSIFIER_REFERER`          | no       | unset                            | OpenRouter analytics header.          |
| `HEARME_CLASSIFIER_TITLE`            | no       | unset                            | OpenRouter analytics header.          |

## Local dev

```bash
cd packages/classifier
npm install
npm run typecheck
npm test
HEARME_CLASSIFIER_DATABASE_URL=postgres://hearme_classifier:hearme_classifier_dev@localhost:5432/hearme \
  HEARME_CLASSIFIER_OPENROUTER_API_KEY=sk-or-... \
  HEARME_CLASSIFIER_ONE_SHOT=1 \
  npm run dev
```

The compose stack runs it as the `classifier` service; the local `dev` command
is for iterating on the code without rebuilding the container.
