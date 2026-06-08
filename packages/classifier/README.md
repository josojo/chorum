# chorum-classifier

Background TypeScript worker that assigns a topic to each new question in the
chorum broker DB by asking a cheap OpenRouter LLM (default
`google/gemini-2.5-flash-lite`). The broker only serves questions whose topic
has been set, so this service is the gate between "asker just posted" and
"agent is allowed to see it."

## Why this exists

If askers picked the topic themselves, someone asking
"Is metformin worth the side effects?" could just label it `ai` and slip past
the skill's `auto_answer_topics` privacy filter (see
`packages/skill/src/chorum_skill/policy.py`). The classifier makes the topic
asker-INDEPENDENT, picking 1–3 tokens from a fixed taxonomy
(`packages/proto/topics.json`) based on the question text alone.

## Architecture

- One Node process. Polls Postgres on a fixed interval; no message bus.
- DB role: `chorum_classifier` — column-level `UPDATE(topic)` on `questions`,
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
| `CHORUM_CLASSIFIER_DATABASE_URL`     | yes      | —                                | postgres-js DSN, `chorum_classifier`. |
| `CHORUM_CLASSIFIER_OPENROUTER_API_KEY` | yes    | —                                | OpenRouter key.                       |
| `CHORUM_CLASSIFIER_MODEL`            | no       | `google/gemini-2.5-flash-lite`   | OpenRouter model slug.                |
| `CHORUM_CLASSIFIER_POLL_INTERVAL_MS` | no       | `10000`                          | Tick cadence.                         |
| `CHORUM_CLASSIFIER_BATCH_SIZE`       | no       | `20`                             | Max rows per tick.                    |
| `CHORUM_CLASSIFIER_ONE_SHOT`         | no       | `0`                              | `1` → exit after one tick.            |
| `CHORUM_CLASSIFIER_LOG_LEVEL`        | no       | `info`                           | `debug` / `info` / `warn` / `error`.  |
| `CHORUM_CLASSIFIER_REFERER`          | no       | unset                            | OpenRouter analytics header.          |
| `CHORUM_CLASSIFIER_TITLE`            | no       | unset                            | OpenRouter analytics header.          |

## Local dev

```bash
cd packages/classifier
npm install
npm run typecheck
npm test
CHORUM_CLASSIFIER_DATABASE_URL=postgres://chorum_classifier:chorum_classifier_dev@localhost:5432/chorum \
  CHORUM_CLASSIFIER_OPENROUTER_API_KEY=sk-or-... \
  CHORUM_CLASSIFIER_ONE_SHOT=1 \
  npm run dev
```

The compose stack runs it as the `classifier` service; the local `dev` command
is for iterating on the code without rebuilding the container.
