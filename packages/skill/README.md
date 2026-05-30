# hearme-skill

The Hearme Hermes skill — a local agent that answers questions on the user's
behalf, signs them, and submits them to the broker.

See [ARCHITECTURE.md §6-8](../../ARCHITECTURE.md) for the canonical spec this
package implements. This README documents how to install, run, and test it.

## Architecture overview

Seven linear layers (ARCHITECTURE.md §7). Each layer is one module; layers
below never call layers above.

```
        ┌────────────────────────┐
   in   │  Channel (broker I/O)  │   out          broker.py
        └────────────┬───────────┘
                     │
        ┌────────────▼───────────┐
        │  Policy (gate)         │                policy.py
        └────────────┬───────────┘
                     │
        ┌────────────▼───────────┐
        │  Persona (projection)  │                persona.py + memory/
        └────────────┬───────────┘
                     │
        ┌────────────▼───────────┐
        │  Answerer (LLM)        │                answerer.py + llm/
        └────────────┬───────────┘
                     │
        ┌────────────▼───────────┐
        │  Envelope              │                envelope.py + delegation.py
        │  (signs, binds nonce)  │                + crypto/
        └────────────┬───────────┘
                     │
        ┌────────────▼───────────┐
        │  Ledger (local SQLite) │                ledger.py
        └────────────┬───────────┘
                     │
        ┌────────────▼───────────┐
        │  UI (Hermes channels)  │                ui.py
        └────────────────────────┘
```

The DelegationToken is set up out-of-band by `onboarding.py` (§8) and lives
encrypted on disk. **The Envelope layer is the only layer that reads it.**
In particular, **the Answerer never sees the DelegationToken or
`unique_identifier`** — enforced by the function signature in `answerer.py`
and asserted by `tests/test_identity_inference_separation.py`.

## Install + run

```bash
# from packages/skill/
pip install -e '.[dev]'

# 1. Generate the agent key, show the Self QR codes (one per age threshold),
#    collect the proofs, and register with the broker (verify-once). Scan with
#    the Self app (a mock passport works with SELF_MOCK_PASSPORT=1). Requires the
#    self-bridge (packages/self-bridge) and the broker running.
hearme-skill onboard --bridge-url http://localhost:8787 --broker-url http://localhost:8000

# 2. (Dev only) Replay a captured proof fixture through /v1/register instead of
#    scanning live (prints the broker-issued token):
python ../../scripts/mock-onboard.py --from-bridge /tmp/bridge-result.json \
    --broker-url http://localhost:8000 > /tmp/token.json
hearme-skill accept-mock-delegation /tmp/token.json

# 3. Configure policy (sample below). Hearme defaults to off.
$EDITOR ~/.hermes/hearme/policy.yaml
```

In production this package is a **Hermes plugin**. Hermes discovers it via the
`hermes_agent.plugins` entry point (`hearme = hearme_skill.plugin:register`)
and calls `register(ctx)`, which exposes two tools — `hearme_list_open_questions`
and `hearme_submit_answer` — under the `hearme` toolset. A Hermes **cron job**
(`schedule.py`) fires on a schedule and the host agent answers open questions
through those tools, **using its own configured model and memory**. There is no
second model-provider API key and no model SDK imported here — see
[Running inside Hermes](#running-inside-hermes).

## Sample `policy.yaml`

```yaml
# ~/.hermes/hearme/policy.yaml
#
# All categories default to off (§1.1). `auto_answer` is the master switch for
# the unattended cron flow: the tools only surface and accept a question when
# the policy gate returns "answer", which requires `auto_answer: true`. Leave it
# false and the agent will never auto-submit (the §1.12 override stays with you).

topic_allowlist:
  - coffee
  - travel
topic_blocklist:
  - politics

max_answers_per_day: 50
min_payment: 0.0              # v0: ignored, no payment field on questions
auto_answer: true            # required for the cron job to auto-submit
auto_submit_window_seconds: 0 # legacy preview window for the dev loop only
```

## Configuration knobs (env vars, prefix `HEARME_SKILL_`)

| Variable                                | Default                  | Meaning                                              |
|-----------------------------------------|--------------------------|------------------------------------------------------|
| `HEARME_SKILL_BROKER_URL`               | `http://localhost:8000`  | Where to find `hearme-broker`.                       |
| `HEARME_SKILL_POLL_INTERVAL_SECONDS`    | `30`                     | Cadence for `GET /v1/questions/open`.               |
| `HEARME_SKILL_AUTO_SUBMIT_WINDOW_SECONDS` | `0`                    | Default preview window (policy.yaml overrides).      |
| `HEARME_SKILL_ROOT_DIR`                 | `~/.hermes/hearme/`      | Where keys, ledger, and token live.                  |

`POLL_INTERVAL_SECONDS` / `AUTO_SUBMIT_WINDOW_SECONDS` apply only to the dev
loop (`dev_runner`); the production path is the Hermes cron job, whose cadence
is set with `hearme-skill schedule --schedule ...`. In the agentic tools,
idempotency comes from the ledger (`has_submission`), not a polling cursor — so
a question the agent skips reappears next cycle.

## Privacy guarantees

What the broker sees, per envelope (the five-field POST body in §8.5):
`question_id`, `answer`, `nonce`, `delegation_token`, `agent_signature`.

What the broker NEVER sees:
- The user's raw memory / source quotes / chain-of-thought.
- The `Answer.rationale` field (it never leaves the local ledger).
- Demographic fields outside what's pre-baked into the DelegationToken's
  `disclosed_predicates` at install time (§1.3).
- Passport material (the skill never holds it; the phone does).
- Whether a question is a honeypot (the skill doesn't even ask itself —
  §1.7).

Coercion resistance (§1.6): the skill emits no signed receipt beyond the
envelope itself, ships no plaintext log off-device, and takes no
screenshots. The local audit trail in `~/.hermes/hearme/ledger.sqlite` is
the only persistence.

## Testing

```bash
pytest
```

Mandatory tests (per ARCHITECTURE.md §12, all in `tests/`):

- `test_policy.py` — deterministic gate decisions.
- `test_ledger.py` — schema + idempotency.
- `test_delegation_lifecycle.py` — load / expiry / refresh-window detection.
- `test_envelope_signing.py` — property: flip any byte → signature rejects.
- `test_persona_projection.py` — snapshot tests; no demographics or raw IDs.
- `test_answerer.py` — fake LLM client, no live calls.
- `test_identity_inference_separation.py` — answerer double asserts on call
  args; can never receive DelegationToken / `unique_identifier`.
- `test_no_phone_contact.py` — 100 simulated answers, phone bridge mock
  receives ZERO calls (§1.13).
- `test_tools.py` — the framework-agnostic answering tools: policy backstop,
  replay-safety, and that the delegation token never leaves `submit_answer`.

Per §12, **no live LLM calls in CI**. All Answerer tests use the
deterministic `FakeLLMClient` in `llm/client.py`.

## Running inside Hermes

Production answering runs inside the user's existing [Hermes
agent](https://github.com/NousResearch/hermes) (>= 0.14). The agent already has
a model + provider configured in `~/.hermes/config.yaml`, so Hearme adds **no
new API key** — inference is whatever model the user already runs.

```bash
# 1. Install hearme-skill into the SAME venv your hermes-gateway runs from.
#    Find that Python via the cgroup line of `systemctl --user status
#    hermes-gateway` (typically `/path/to/.venv/bin/python`):
GATEWAY_PY=/home/youruser/.venv/bin/python   # adjust to your install
GATEWAY_BIN=$(dirname "$GATEWAY_PY")          # same venv's bin/ dir
"$GATEWAY_PY" -m pip install \
  'git+https://github.com/josojo/hearme.git#subdirectory=packages/skill'
#    Developing against a local checkout? Use an editable install instead:
#    "$GATEWAY_PY" -m pip install -e packages/skill
#    The venv has no pip? Bootstrap it once:
#    "$GATEWAY_PY" -m ensurepip --upgrade

# 2. Write the Hermes plugin drop-in (~/.hermes/plugins/hearme/) and restart
#    the gateway so it picks up the freshly-installed package.
#
#    `hearme-skill` is a console script pip dropped into the venv's bin/ dir;
#    it is not a python -m module. Call the executable directly with its
#    absolute path so you pick the gateway venv's copy (not whatever's on
#    your shell $PATH from pyenv or another venv). The module form
#    `"$GATEWAY_PY" -m hearme_skill.skill install-plugin` works too — note
#    the UNDERSCORE in the module name; the dist name uses a hyphen but
#    Python modules cannot.
"$GATEWAY_BIN/hearme-skill" install-plugin

# 3. Opt the plugin in. Hermes 0.14 doesn't auto-enable user plugins; until
#    `hearme` is in `plugins.enabled` of ~/.hermes/config.yaml the gateway
#    discovers it (it shows in `hermes plugins list`) but skips loading it
#    (no entry in `hermes tools list`). `hermes plugins enable` updates the
#    config and reloads the gateway.
hermes plugins enable hearme

# 4. Onboard once (verify-once with Self; needs the broker + self-bridge).
#    Generates the agent key, walks the Self QR flow, registers with the
#    broker, persists the DelegationToken, and (if a token exists)
#    self-registers the answering cron job.
"$GATEWAY_BIN/hearme-skill" onboard \
  --bridge-url http://localhost:8787 --broker-url http://localhost:8000

# 5. Author your policy (see the sample above). `auto_answer: true` is what
#    lets the cron job answer unattended.
$EDITOR ~/.hermes/hearme/policy.yaml
```

Steps 1–4 are the install proper; step 5 is policy. Conceptually: (1) makes
`hearme_skill` importable by the gateway, (2) registers it as a Hermes plugin
on disk, (3) opts in so Hermes actually loads it, (4) wires your identity in
and schedules the cron.

> **Why the absolute paths?** Putting `/home/youruser/.venv/bin` on `$PATH`
> turns `hearme-skill install-plugin` into the same command. If you do that,
> just `hearme-skill install-plugin` works. But on a box where the gateway
> runs as a systemd unit and you also have pyenv on `$PATH`, the bare name
> can resolve to a `hearme-skill` from a *different* venv that doesn't have
> the package — pinning the absolute path is the safe default.

Verify with:

```bash
hermes plugins list | grep hearme
hermes tools list   | grep hearme        # expect hearme_list_open_questions + _submit_answer
```

Already onboarded and just need to re-register the cron job? It's idempotent
(`$GATEWAY_BIN` from step 1):

```bash
"$GATEWAY_BIN/hearme-skill" schedule              # default schedule (see schedule.py:DEFAULT_SCHEDULE)
# "$GATEWAY_BIN/hearme-skill" schedule --schedule "0 * * * *"   # or a cron expression
```

### Why this install shape (and not `hermes plugins install`)

Hermes ships two builtin install commands; neither fits a monorepo Python plugin:

- **`hermes skills install …`** is for SKILL.md files the agent reads as instructions — wrong subsystem. We're a plugin (Python code that registers tools).
- **`hermes plugins install owner/repo`** clones the repo root, expects `plugin.yaml` at the top, and **does not pip-install dependencies**. Our `plugin.yaml` lives in `packages/skill/`, and we have third-party deps (`pynacl`, `pydantic`, `httpx`, …), so this path silently half-installs and never registers the tools. Hermes' own docs recommend pip-distribution for plugins with deps.

So: one pip command (installs code + deps into the gateway venv) followed by `hearme-skill install-plugin` (writes the directory drop-in Hermes loads at boot). `onboard` chains them automatically.

### Install troubleshooting

- **Tools missing from `hermes tools list` after install.** Walk these in order:
  1. The package isn't in the gateway's venv — confirm with
     `"$GATEWAY_PY" -m pip show hearme-skill`. The gateway's Python is whatever
     `systemctl --user status hermes-gateway` shows under cgroup.
  2. The plugin drop-in under `~/.hermes/plugins/hearme/` is missing or stale.
     `hearme-skill install-plugin` rewrites both files.
  3. `hearme` isn't in `plugins.enabled` of `~/.hermes/config.yaml`. Symptom:
     `hermes plugins list` shows it, `hermes tools list` doesn't, and the
     gateway log says `Skipping 'hearme' (not in plugins.enabled)`. Fix:
     `hermes plugins enable hearme`.
  4. The gateway wasn't restarted. `systemctl --user restart hermes-gateway`.
- **The venv has no `pip`.** Some venvs ship without it (`python -m venv --without-pip`, `uv venv`, etc.). Bootstrap once: `"$GATEWAY_PY" -m ensurepip --upgrade`.
- **Half-installed leftover from a failed `hermes plugins install josojo/hearme`.** That command clones the whole monorepo into `~/.hermes/plugins/hearme/` (mostly junk, no manifest at the right level) and then refuses re-installs. Wipe and use the canonical path: `rm -rf ~/.hermes/plugins/hearme && hearme-skill install-plugin`.
- **`Plugin 'hearme' has no register() function` in DEBUG logs but our `plugin.py` clearly has one.** This means Hermes loaded us via the pip entry-point path (it dedupes by plugin name and the entry-point wins over the directory drop-in), and the entry-point value resolved to the *function* rather than the *module*. Pre-2026-05 builds shipped `hearme = "hearme_skill.plugin:register"`, which makes `ep.load()` return the function and then `getattr(<func>, "register")` is `None`. Fixed by changing the entry to `hearme = "hearme_skill.plugin"`. If you hit this on an older checkout, upgrade the package: `"$GATEWAY_PY" -m pip install --force-reinstall --no-deps 'git+https://github.com/josojo/hearme.git#subdirectory=packages/skill'`.
- **`Unknown tool 'hearme_list_open_questions'` in the gateway logs.** Always means the plugin loader never ran or ran but registered zero tools. The four-step walk under the first bullet covers the common cases. Bring the journal up with the relevant detail:
  ```bash
  journalctl --user -u hermes-gateway --since "30 sec ago" -o cat \
    | grep -iE 'plugin|hearme|traceback|skipping' -A 3
  ```

### How a cycle runs

1. The `hermes gateway` daemon fires the `hearme-answer-cycle` cron job on its
   schedule (default every 15 minutes).
2. Hermes runs **your** configured model with the `hearme` toolset enabled,
   under the prompt in `schedule.py:ANSWER_PROMPT`.
3. The agent calls `hearme_list_open_questions`, decides each answer from what
   it knows about you (its own memory), and calls `hearme_submit_answer`.
4. `hearme_submit_answer` (deterministic, in `tools.py`) re-checks the policy
   gate, loads the delegation token + agent key, signs the envelope, and posts
   it to the broker.

The model never sees the delegation token, `unique_identifier`, or the signing
nonce — those live only inside the tools. Unattended auto-submit is gated by
`auto_answer: true` (see the §1.12 note in [ARCHITECTURE.md](../../ARCHITECTURE.md)).

### Dev loop (no Hermes, no key)

`python -m hearme_skill.dev_runner` runs the legacy in-process pipeline against
the broker with `FakeLLMClient` + `Mem0StubProvider` — no network LLM, no API
key. This exercises Persona → Answerer → Envelope locally and is what CI uses
(ARCHITECTURE.md §12, "never live LLM in CI"). It is **not** the production path.

## ChatGPT export memory sidewheel

Hearme can also use a local memory DB built from a ChatGPT data export. This
does **not** read the running ChatGPT macOS app or scrape its private storage;
the user downloads an export from ChatGPT and imports it explicitly.

```bash
cd packages/skill
pip install -e .

# Import a ChatGPT export ZIP, extracted export directory, or conversations.json.
hearme-skill chatgpt-import ~/Downloads/chatgpt-export.zip

# Optional smoke test against the local DB.
hearme-skill chatgpt-query "Do I like espresso?" --topic coffee

# Use the imported DB in the standalone/dev host.
HEARME_SKILL_MEMORY_BACKEND=chatgpt-export python -m hearme_skill.dev_runner
```

By default the importer indexes only user-authored messages. Add
`--include-assistant` if you want assistant replies included too. The local DB
lives at `~/.hermes/hearme/chatgpt_memory.sqlite` unless `--db` is supplied.

## Not yet real (every `# STUB:` in code)

- **Payments.** No payment fields on the wire; `policy.min_payment`
  parsed for forward-compat but never read. (ARCHITECTURE.md §11)
- **Memory provider.** `Mem0StubProvider` is still the deterministic default.
  The optional ChatGPT export sidewheel imports a user-provided export into
  local SQLite FTS and can be selected with
  `HEARME_SKILL_MEMORY_BACKEND=chatgpt-export`. Hermes memory remains the
  production integration path.
- **Multi-channel UI.** Telegram-only in v0; `InMemoryChannel` stub for
  tests. The `Channel` Protocol is the v0.2 plug point.
- **Live revocation handling.** The skill respects expiry; it does not yet
  consult a broker-side revocation feed. The broker already has the
  `revocations` table ready.
- **Honeypot signal parsing.** Stubbed; the Policy layer deliberately
  never branches on "is this a test" (§1.7).
- **Encrypted-at-rest storage.** Both the agent key (`crypto/keystore.py`)
  and the delegation token (`delegation.py`) are written as plaintext with
  0600 perms. SQLCipher / OS keychain in v0.1. Ledger encryption likewise.
- **Self proof verification is broker-side.** The skill never runs the SNARK; it
  collects the Self proofs and posts them to the broker's `/v1/register`, which
  verifies them once and returns the signed DelegationToken the skill replays.
- **Lost-phone recovery.** Re-enroll from a fresh install.

## Design choices worth flagging

- **Light-topic auto-answer by default.** So a freshly-onboarded agent
  actually participates instead of sitting idle on the cron, questions whose
  `topic` tag matches the curated low-stakes set (`DEFAULT_AUTO_ANSWER_TOPICS`
  in `policy.py` — AI/agents, IT/software, hobbies, entertainment) are answered
  unattended. Sensitive topics (politics, health, finance, …) are deliberately
  absent and still require the global `auto_answer: true` opt-in. The
  `topic_blocklist` always wins, and matching is by word-token (so the tag
  `ai agents` matches `ai`, but `fair` does not). Tune or disable it in
  `policy.yaml`:
  ```yaml
  # broaden, narrow, or empty out ([]) the light-topic set
  auto_answer_topics: [ai, agents, gaming, music, knitting]
  # or open everything (tagged or not) to unattended answering:
  auto_answer: true
  ```
- **Untagged questions still prompt.** A question with no `topic` can't be
  classified as light, so it falls back to the user (`prompt_user`) unless
  `auto_answer: true` — §1.12 "override is sacred" still holds for anything
  outside the light set.
- **`Answer.rationale` is captured locally** for the audit ledger, but the
  `build_envelope` API takes `answer_text: str` (not `Answer`) so it's
  structurally impossible for the rationale to slip onto the wire.
- **Persona projection is paranoid about demographics**: even though the
  v0 memory stub never emits demographic fields, `persona.project` filters
  any fact whose lowercased form starts with `age:`, `gender:`, `country:`,
  `region:`, or `ethnicity:`. Demographics live in the DelegationToken
  only.

## Wire-format alignment

The Pydantic models in `hearme_skill.models` mirror `packages/proto/`
field-for-field. The canonical-JSON helper in `hearme_skill.crypto.canonical`
produces byte-identical output to the broker's verifier (sorted keys, no
whitespace, UTC `Z` suffix). The end-to-end suite at the repo root will
fail if these drift apart.
