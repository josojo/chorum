# inspect.md — how to inspect the hearme stack

Practical commands for figuring out **what is happening** when the hearme skill
is installed in a Hermes agent answering questions against the staging broker.
Three places to look:

1. **Local Hermes agent** — the gateway daemon + cron on your box.
2. **Local skill state** — the ledger, delegation token, policy.
3. **Staging server** — broker, self-bridge, Caddy on EC2.

---

## TL;DR — "did anything happen?"

```bash
# Local: did the cron fire and did the skill log anything?
journalctl --user -u hermes-gateway.service --since today -n 200

# Local: what did the skill actually record?
sqlite3 ~/.hermes/hearme/ledger.sqlite '.tables'
sqlite3 -header -column ~/.hermes/hearme/ledger.sqlite \
  'SELECT * FROM submissions ORDER BY rowid DESC LIMIT 10;'

# Server: any envelopes arrive at the broker?
ssh -i ~/.ssh/hearme-staging.pem ubuntu@3.121.186.133 \
  'cd ~/hearme && docker compose -f docker-compose.yml -f docker-compose.staging.yml logs broker --since=1h | grep -E "envelopes|register"'
```

---

## 1. Local Hermes agent

### Find the service unit

```bash
# user-scope (typical for personal installs)
systemctl --user list-units --type=service --all | grep -i hermes

# system-scope (if installed with `hermes gateway install --system`)
systemctl list-units --type=service --all | grep -i hermes
```

### Status, recent + follow

```bash
systemctl --user status hermes-gateway.service
journalctl --user -u hermes-gateway.service -f
journalctl --user -u hermes-gateway.service --since today -n 500
journalctl --user -u hermes-gateway.service --since "1 hour ago"
```

The skill itself logs under the Python loggers `hearme_skill.tools`,
`hearme_skill.schedule`, `hearme_skill.broker`, `hearme_skill.register`. Filter:

```bash
journalctl --user -u hermes-gateway.service | grep hearme_skill
```

### Cron job — list, run-now, history

```bash
hermes cron --help                    # confirm subcommands in your version
hermes cron list                      # find 'hearme-answer-cycle'
hermes cron run hearme-answer-cycle   # fire NOW (don't wait for the schedule)
hermes cron history hearme-answer-cycle
```

The output of a forced run appears in the gateway journal — keep
`journalctl … -f` open in another terminal while you trigger it.

### Gateway lifecycle

```bash
hermes gateway install --force        # regenerate the systemd unit (after upgrades)
systemctl --user daemon-reload
systemctl --user restart hermes-gateway.service

# verify the regenerated unit has a long-enough drain timeout (no SIGKILL mid-drain)
systemctl --user show hermes-gateway.service -p TimeoutStopUSec
# expect TimeoutStopUSec=3min 30s or more
```

### Gateway is not under systemd

```bash
ps -ef | grep -i hermes | grep -v grep    # find the foreground process
hermes gateway stop                       # graceful stop if it's a managed gateway
pkill -f 'hermes.*gateway'                # hammer
```

`hermes gateway run` starts the gateway in the **foreground** of the current
shell — its stdout/stderr is whatever the launching terminal points at, not
journalctl. Closing the shell kills it.

---

## 2. Local skill state

### Files

```bash
ls -la ~/.hermes/hearme/
# agent_key          Ed25519 signing key (0600)
# delegation.token   broker-issued JWT-like JSON (90-day TTL)
# policy.yaml        what you let the skill answer
# ledger.sqlite      local audit DB
# chatgpt_memory.sqlite   (only if you imported a ChatGPT export)
```

### Delegation token — expiry, predicates

```bash
python3 -m json.tool < ~/.hermes/hearme/delegation.token
# inspect `expires_at`, `disclosed_predicates` (region, country, age_band),
# and the broker signature.
```

### Policy

```bash
cat ~/.hermes/hearme/policy.yaml
```

Two gotchas worth re-checking when nothing seems to happen:

- `auto_answer: true` is **required** for the cron to submit unattended.
- A narrow `topic_allowlist` blocks everything else. The seed questions on
  staging use topics like `technology`, `work`, `habits`, `relationships`.

### Ledger — the structured truth

```bash
sqlite3 ~/.hermes/hearme/ledger.sqlite '.tables'
# expect: questions, answers, submissions, revocations, question_spend, meta

sqlite3 ~/.hermes/hearme/ledger.sqlite '.schema submissions'

# what the broker accepted / rejected (most recent first)
sqlite3 -header -column ~/.hermes/hearme/ledger.sqlite \
  'SELECT question_id, accepted, reason, submitted_at
   FROM submissions ORDER BY rowid DESC LIMIT 10;'

# what the agent actually wrote (rationale stays local, never on the wire)
sqlite3 -header -column ~/.hermes/hearme/ledger.sqlite \
  'SELECT question_id, answer_text, rationale, created_at
   FROM answers ORDER BY rowid DESC LIMIT 10;'

# every question the skill has seen (and skipped or answered)
sqlite3 -header -column ~/.hermes/hearme/ledger.sqlite \
  'SELECT question_id, text, topic, closes_at
   FROM questions ORDER BY rowid DESC LIMIT 10;'
```

The ledger is the **most reliable** source of truth — skipped-by-policy
decisions are recorded too, so it tells you exactly why a cron cycle was quiet.

### Was the plugin discovered by Hermes?

```bash
python3 -c "from importlib.metadata import entry_points; \
print([ep.name for ep in entry_points(group='hermes_agent.plugins')])"
# expect 'hearme' in the list
```

Must be in the **same Python env** as the running Hermes agent.

---

## 3. Staging server

Deployed at `3.121.186.133` under `/home/ubuntu/hearme` (proper git checkout of
`main`). SSH is locked to the admin IP.

```bash
ssh -i ~/.ssh/hearme-staging.pem ubuntu@3.121.186.133
cd ~/hearme
dc='docker compose -f docker-compose.yml -f docker-compose.staging.yml'
```

### Container status

```bash
$dc ps
# expect 5 services: broker, self-bridge, web, postgres, caddy — all Up + healthy
```

### Broker logs (HTTP wire + skill events)

```bash
$dc logs broker --since=30m
$dc logs broker --since=1h | grep -E "register|envelope|verify|reason"
$dc logs broker -f
```

Useful patterns to grep for:

- `POST /v1/register HTTP/1.1`   → onboarding hit the broker.
- `POST /v1/envelopes HTTP/1.1`  → an answer landed.
- `registration verify failed: <reason>` → onboarding rejection (reason is a
  `RejectionReason` enum value — see `packages/broker/.../models/schemas.py`).
- `envelope verify failed: <reason>`     → answer rejection.

### Self-bridge logs (Self proof verification)

```bash
$dc logs self-bridge --since=30m
curl -s http://localhost:8787/healthz | python3 -m json.tool
# public staging overlay expects mockPassport:false, devMode:false,
# registryCheck:true, endpointOk:true
```

### Caddy access logs (the HTTPS edge for the Self-app callback)

```bash
$dc logs caddy --since=30m | grep -E '"method":|/self/'
```

This is where you see incoming proof POSTs from the Self relayer
(`POST /self/callback`).

### Postgres — broker DB directly

```bash
$dc exec postgres \
  psql -U hearme_admin hearme -c 'SELECT count(*) FROM registrations;'
$dc exec postgres \
  psql -U hearme_admin hearme \
  -c 'SELECT question_id, count(*) FROM envelopes GROUP BY question_id ORDER BY 2 DESC LIMIT 10;'
$dc exec postgres psql -U hearme_admin hearme -c '\d envelopes'
```

### Health probes (no SSH needed)

```bash
curl -s -o /dev/null -w "web (https):  HTTP %{http_code}\n"  https://3-121-186-133.sslip.io/
curl -s https://3-121-186-133.sslip.io/self/healthz             ; echo
```

---

## 4. End-to-end correlation during a cron fire

Open three terminals and trigger a cycle:

```bash
# Terminal A — local hermes journal
journalctl --user -u hermes-gateway.service -f

# Terminal B — broker on staging
ssh -i ~/.ssh/hearme-staging.pem ubuntu@3.121.186.133 \
  'cd ~/hearme && docker compose -f docker-compose.yml -f docker-compose.staging.yml logs broker -f'

# Terminal C — fire the cron
hermes cron run hearme-answer-cycle
```

A complete cycle leaves three traces, in order:

1. (A) `hearme_skill.tools` lines for `list_open_questions` → `submit_answer`.
2. (B) `POST /v1/envelopes HTTP/1.1 200 OK` per submitted answer.
3. (Local) row in `submissions` with `accepted=1`.

If any of those is missing, the absence tells you where the cycle stalled.

---

## 5. Common questions → exact commands

| Question | Command |
|---|---|
| Did the cron fire on time? | `journalctl --user -u hermes-gateway.service --since "30 min ago"` |
| Did the skill submit anything? | `sqlite3 ~/.hermes/hearme/ledger.sqlite 'SELECT * FROM submissions ORDER BY rowid DESC LIMIT 5;'` |
| Did the broker accept? | Same row — column `accepted`; rejection in `reason`. |
| What did Hermes actually answer? | `sqlite3 ~/.hermes/hearme/ledger.sqlite 'SELECT question_id, answer_text FROM answers ORDER BY rowid DESC LIMIT 5;'` |
| Is my delegation token still valid? | `python3 -m json.tool < ~/.hermes/hearme/delegation.token` (check `expires_at`) |
| Are the staging services healthy? | The `curl … /healthz` block in §3. |
| Did the proof reach the bridge during onboarding? | Caddy logs filtered to `/self/`. |
| Why did the broker reject? | `$dc logs broker | grep -E "register|envelope" | grep -i fail` |
| How many answers from my agent landed? | `$dc exec postgres psql -U hearme_admin hearme -c "SELECT count(*) FROM envelopes WHERE delegation_hash = decode('<hex>','hex');"` (hash is in the `submissions` ledger) |
