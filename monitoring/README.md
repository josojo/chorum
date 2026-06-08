# Observability stack (issue #101)

The broker exposes Prometheus metrics and forwards unhandled exceptions to
Sentry; this directory holds the **monitoring side**: a Prometheus +
Alertmanager + blackbox-exporter + Grafana stack you run as a compose overlay.

## Run it

Overlay the monitoring file on the app stack so the containers share a network
and resolve service hostnames:

```sh
# local / staging
docker compose -f docker-compose.yml -f docker-compose.monitoring.yml up -d
# prod
docker compose -f docker-compose.prod.yml -f docker-compose.monitoring.yml up -d
```

All UIs bind to **loopback only** and are not routed by Caddy. Reach them over an
SSH tunnel:

```sh
ssh -L 9090:localhost:9090 -L 9093:localhost:9093 -L 3001:localhost:3001 <box>
```

| UI | URL | What |
|---|---|---|
| Prometheus | http://localhost:9090 | targets, `/alerts`, ad-hoc queries |
| Alertmanager | http://localhost:9093 | firing/silenced alerts |
| Grafana | http://localhost:3001 | dashboards (Prometheus datasource pre-provisioned; admin/admin by default) |

## What's collected

The broker serves `/metrics` (prom-client) on `:8000`, scraped over the internal
network (never via Caddy). Series:

| Metric | Labels | Use |
|---|---|---|
| `chorum_broker_register_total` | `outcome` | registration rate (accepted vs rejected) |
| `chorum_broker_envelopes_total` | `outcome` | envelope ingest rate |
| `chorum_broker_revoke_total` | `outcome` | revoke rate |
| `chorum_broker_rejections_total` | `route`, `reason` | verification-failure breakdown by `RejectionReason` |
| `chorum_broker_ratelimited_total` | `route` | 429 rate |
| `chorum_broker_*` (default) | — | process: rss, event-loop lag, GC, fds |

Liveness for services without `/metrics` (self-bridge, web) is covered by
blackbox HTTP probes of their `/healthz`, so down-alerts work today.

## Alerts

Defined in `prometheus/alerts.yml`:

- **BrokerScrapeDown / BrokerHealthzFailing / SelfBridgeHealthzFailing** — down detection (critical).
- **BrokerEnvelopeRejectionSpike / BrokerRegisterRejectionSpike** — error-rate spikes (warning).
- **BrokerRateLimitPressure** — sustained 429s (warning).

`alertmanager/alertmanager.yml` ships a **no-op receiver** — alerts show in the
UI but nothing is paged. To page, uncomment the Slack/webhook receiver and supply
the secret via env (store it in AWS SSM — see `docs/DEPLOYMENT.md` §1.1 — never
commit it).

## Follow-ups (out of scope for the broker-first PR)

- Native `/metrics` for web, self-bridge, classifier (incl. the **classifier
  backlog** gauge — `COUNT(*) FROM questions WHERE topic IS NULL AND status='open'`).
- Sentry SDK in those three services (same env-gated pattern as the broker).
- A committed Grafana dashboard JSON.
