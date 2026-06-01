# hearme-skill

The Hearme answering skill — a local agent that answers public questions on the
user's behalf, signs them with an Ed25519 agent key, and submits them to the
broker. It wires into **Hermes** and **OpenClaw** from one shared core.

This package is a **single self-contained Rust binary** (`hearme-skill`). There
is no Python or Node toolchain to install and no second codebase: the binary is
the implementation, and each host gets a thin adapter that shells out to it.

See [ARCHITECTURE.md §6-8](../../ARCHITECTURE.md) for the canonical spec. This
README covers install, the CLI, how it wires into each host, configuration, and
building from source.

> **Just want to install it?** Two commands, no toolchain — jump to
> [Install](#install-prebuilt-binary).

## Why a Rust binary

The skill used to ship as a PyInstaller-frozen Python CLI (~30–50 MB). It is now
a ~3 MB statically-featured Rust binary: TLS via rustls (no system OpenSSL),
SQLite via the bundled amalgamation (FTS5 enabled), Ed25519 via `ed25519-dalek`,
canonical JSON via key-sorted `serde_json`. The crypto is **byte-identical** to
the TypeScript broker's verifier — the golden vectors in
`packages/broker/tests/goldens.test.ts` are pinned as unit tests in
[`src/canonical.rs`](src/canonical.rs) and [`src/crypto.rs`](src/crypto.rs).

## Install (prebuilt binary)

```bash
# 1. Download the binary for this machine (Linux x86_64 / aarch64). Installs to
#    ~/.local/bin/hearme-skill. No Python, pip, or Node required.
curl -fsSL https://github.com/josojo/hearme/releases/latest/download/install.sh | sh

# 2. Wire it into whatever agent host is installed (auto-detects Hermes and/or
#    OpenClaw; use --host hermes|openclaw|both to force one).
hearme-skill install

# 3. One-time identity setup (Self verify-once; needs the broker + self-bridge).
hearme-skill onboard --broker-url <url> --bridge-url <url>
```

> **Linux-first.** Only Linux x86_64/aarch64 binaries are published (the matrix
> in `.github/workflows/build-binaries.yml` is easy to extend). The release
> binaries target musl so they do not require the installing machine to have the
> same glibc version as GitHub's build runners. On other platforms, build from
> source (below). `install.sh` drops the binary in `~/.local/bin`; if that's not
> on the host's `PATH`, add it or point the generated Hermes shim / OpenClaw
> `SKILL.md` at the absolute path.

## CLI

| command | what it does |
|---------|--------------|
| `hearme-skill install [--host auto\|hermes\|openclaw\|both]` | detect host(s), install the plugin/skill for each |
| `hearme-skill install-plugin` | write the Hermes drop-in (`~/.hermes/plugins/hearme/`) + restart the gateway |
| `hearme-skill install-openclaw` | write the OpenClaw skill (`~/.openclaw/skills/hearme/`) + register the cron |
| `hearme-skill onboard --broker-url U --bridge-url U` | Self verify-once: agent key, QR codes, register, store token, wire up host(s) |
| `hearme-skill accept-mock-delegation <token.json>` | dev: store a broker-issued token JSON (`-` for stdin) |
| `hearme-skill list-questions` | JSON list of open questions the policy permits answering |
| `hearme-skill submit-answer --question-id ID --answer "Yes — ..."` | sign + submit one answer |
| `hearme-skill review-answers` | JSON of the user's own submitted answers (local ledger read) |
| `hearme-skill revoke-answer --question-id ID` | retract one answer (§1.12) |
| `hearme-skill chatgpt-import <export.zip>` | import a ChatGPT export into a local FTS DB |
| `hearme-skill chatgpt-query "..." [--topic T]` | query the imported memory DB |

`schedule` exists for surface-compatibility but is a no-op in the standalone
binary — the Hermes `cron` API lives inside the gateway's Python process. The
generated plugin shim self-registers the answering cron job once a delegation
token exists, so `install` + `onboard` is all you need.

## How it wires into each host

Both hosts ultimately run the **same binary**; only the adapter differs.

- **Hermes** — `install` / `install-plugin` writes a two-file directory drop-in
  at `~/.hermes/plugins/hearme/`: `plugin.yaml` (manifest) and `__init__.py`, a
  **generated stdlib-only Python subprocess shim**. The gateway is Python but
  needs no `hearme_skill` package — the shim registers the same
  `hearme_list_open_questions` / `hearme_submit_answer` tools and shells out to
  the binary for each call (and self-schedules the cron via the gateway's `cron`
  package once a token exists). The shim's tool schemas + answering prompt are
  baked in from [`src/contracts.rs`](src/contracts.rs) so they cannot drift.
- **OpenClaw** — `install` / `install-openclaw` drops a `SKILL.md` at
  `~/.openclaw/skills/hearme/` whose instructions tell the agent to run the
  binary's CLI via OpenClaw's built-in `exec` tool, and registers a daily
  answering cron via `openclaw cron add`. The committed
  [`openclaw/hearme/SKILL.md`](openclaw/hearme/SKILL.md) is embedded into the
  binary verbatim (`include_str!`), so the file `openclaw skills install ./…`
  reads and the file the installer writes are the same bytes by construction.

`onboard --host auto` (default) detects which host(s) are present and wires up
each. Non-default `--broker-url` / `--bridge-url` are persisted to the host's
env file (`~/.hermes/.env` or `~/.openclaw/.env`) so the scheduled run — a fresh
process that doesn't inherit your shell — hits the same broker.

## Sample `policy.yaml`

```yaml
# ~/.hermes/hearme/policy.yaml
topic_allowlist:
  - coffee
  - travel
topic_blocklist:
  - politics
max_answers_per_day: 50
auto_answer: true            # master switch for unattended auto-submit
auto_answer_topics: [ai, agents, gaming, music]   # light topics answered even when auto_answer is false
```

**Light-topic auto-answer by default.** So a freshly-onboarded agent
participates instead of sitting idle, questions whose `topic` matches the
curated low-stakes set (`DEFAULT_AUTO_ANSWER_TOPICS` in
[`src/policy.rs`](src/policy.rs) — AI/agents, IT/software, hobbies,
entertainment) are answered unattended. Sensitive topics (politics, health,
finance, …) are deliberately absent and still require `auto_answer: true`. The
`topic_blocklist` always wins; matching is by word-token (`ai agents` matches
`ai`, but `fair` does not). Set `auto_answer_topics: []` to disable the default.

## Configuration (env vars, prefix `HEARME_SKILL_`)

| Variable | Default | Meaning |
|----------|---------|---------|
| `HEARME_SKILL_BROKER_URL` | `http://localhost:8000` | Where to find the broker. |
| `HEARME_SKILL_SELF_BRIDGE_URL` | `http://localhost:8787` | self-bridge, used only during onboarding. |
| `HEARME_SKILL_ROOT_DIR` | `~/.hermes/hearme/` | Where the agent key, ledger, token, and policy live. |
| `HEARME_SKILL_MEMORY_BACKEND` | `stub` | `chatgpt-export` to read the imported ChatGPT DB. |

Idempotency comes from the ledger (`has_submission`), not a polling cursor — a
question the agent skips reappears next cycle.

## Privacy guarantees

What the broker sees per envelope (the five-field POST body, §8.5):
`question_id`, `answer`, `nonce`, `delegation_token`, `agent_signature`.

What it NEVER sees: the user's raw memory / chain-of-thought; any local
rationale (never leaves the ledger); demographic fields beyond what's baked into
the DelegationToken's `disclosed_predicates` at install time (§1.3); passport
material (the phone holds it, never the skill); or whether a question is a
honeypot — the policy gate never inspects question text (§1.7).

The DelegationToken and signing nonce never leave the crate: `list-questions`
deliberately omits the nonce, and the token is read only by the envelope/builder
path. The local audit trail in `~/.hermes/hearme/ledger.sqlite` is the only
persistence.

## ChatGPT export memory sidewheel

Builds a local FTS memory DB from a ChatGPT data export the user downloads — it
never reads the running ChatGPT app.

```bash
hearme-skill chatgpt-import ~/Downloads/chatgpt-export.zip   # ZIP, dir, or conversations.json
hearme-skill chatgpt-query "Do I like espresso?" --topic coffee
```

Indexes only user-authored messages by default (`--include-assistant` adds
replies). The DB lives at `~/.hermes/hearme/chatgpt_memory.sqlite` unless `--db`
is given.

## Build from source

```bash
cd packages/skill
cargo build --release        # -> target/release/hearme-skill (~3 MB, stripped)
cargo test                   # unit tests, incl. broker golden vectors
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

CI: [`build-binaries.yml`](../../.github/workflows/build-binaries.yml) builds and
publishes musl-targeted Linux x86_64/aarch64 release assets natively on matching
runners, so the downloaded binaries are not tied to the runner's glibc version.
[`ci.yml`](../../.github/workflows/ci.yml) runs fmt + clippy + test on every PR.

## Module map

| module | role |
|--------|------|
| `canonical.rs` | canonical JSON + `delegation_hash` + envelope/revocation signing inputs (broker byte-compat) |
| `crypto.rs` | Ed25519 keypair load/create/sign + on-disk keystore |
| `models.rs` | `Question`, opaque `DelegationToken`, wire shapes |
| `delegation.rs` | token store/load/expiry + `validate_token` |
| `envelope.rs` | build + sign the 5-field envelope and 3-field revocation |
| `policy.rs` | the deterministic gate + light-topic default |
| `ledger.rs` | local SQLite ledger (questions/answers/submissions/spend) |
| `broker.rs` | HTTP client: open questions, submit, revoke, register |
| `tools.rs` | framework-agnostic `list_open_questions` / `submit_answer` / `review` / `revoke` |
| `onboarding.rs` | Self verify-once flow + QR rendering |
| `contracts.rs` | shared constants + the tool schemas baked into the Hermes shim |
| `hermes.rs` | Hermes plugin-dir install, subprocess shim, env upsert, gateway restart |
| `openclaw.rs` | OpenClaw skill install + cron registration |
| `chatgpt.rs` | ChatGPT export import + FTS query |
| `cli.rs` / `main.rs` | argument parsing + dispatch |

## Not yet real

- **Payments** — no payment field on the wire (`min_payment` not modelled). (§11)
- **Encrypted-at-rest storage** — the agent key and delegation token are written
  as plaintext with 0600 perms; ledger likewise. SQLCipher / OS keychain later (§13).
- **Self proof verification is broker-side** — the skill collects the proofs and
  posts them to `/v1/register`; the broker verifies once and returns the signed token.
- **Live revocation feed** — the skill respects expiry but doesn't yet consult a
  broker-side revocation list.
- **Lost-phone recovery** — re-enroll from a fresh install.
