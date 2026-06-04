#!/usr/bin/env bash
set -euo pipefail

# Per-question voter-tag secret store (ADR-098, ARCHITECTURE_V0.md §1.4).
#
# The broker derives each question's voter tags from that question's OWN random
# secret, and DESTROYS the secret a grace period after the question closes — so a
# closed question's answers become unlinkable to any identity, even to the broker.
# For "destroy" to be real despite RDS's instance-wide backup retention, the
# secrets live in a SEPARATE Postgres instance from the envelopes data.
#
# In production that is a distinct, short-retention RDS instance the broker owns.
# For local dev / CI we simulate the separation with a second DATABASE in this
# same container, OWNED by hearme_broker — which has only USAGE (not CREATE) on
# the shared `hearme` schema, so it could not create the table there anyway. The
# broker owns `hearme_secrets`, so its CREATE TABLE IF NOT EXISTS (secretsDb.ts)
# succeeds. Runs after 02-roles.sh, so the hearme_broker role already exists.

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
SELECT 'CREATE DATABASE hearme_secrets OWNER hearme_broker'
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'hearme_secrets')\gexec
SQL
