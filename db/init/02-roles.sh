#!/usr/bin/env bash
set -euo pipefail

# Local dev defaults are intentionally low-value. Public staging/prod overlays
# must provide these through a gitignored .env / secret manager.
: "${HEARME_DB_WEB_PASSWORD:=hearme_web_dev}"
: "${HEARME_DB_BROKER_PASSWORD:=hearme_broker_dev}"
: "${HEARME_DB_ADMIN_PASSWORD:=${POSTGRES_PASSWORD:-hearme_admin_dev}}"

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  -v admin_user="$POSTGRES_USER" \
  -v admin_password="$HEARME_DB_ADMIN_PASSWORD" \
  -v web_password="$HEARME_DB_WEB_PASSWORD" \
  -v broker_password="$HEARME_DB_BROKER_PASSWORD" <<'SQL'
ALTER ROLE :"admin_user" WITH LOGIN PASSWORD :'admin_password';

SELECT format('CREATE ROLE hearme_web LOGIN PASSWORD %L', :'web_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hearme_web')\gexec

SELECT format('CREATE ROLE hearme_broker LOGIN PASSWORD %L', :'broker_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hearme_broker')\gexec

ALTER ROLE hearme_web    WITH LOGIN PASSWORD :'web_password';
ALTER ROLE hearme_broker WITH LOGIN PASSWORD :'broker_password';

GRANT USAGE ON SCHEMA public TO hearme_web, hearme_broker;

-- Defensive revokes so the intended privacy boundary is visible in the grant
-- script, even if a previous local database allowed these reads. The
-- registrations registry binds passport-derived identity to an agent_key;
-- that's broker-internal verification state and never crosses to the web tier.
REVOKE SELECT ON envelopes     FROM hearme_web;
REVOKE SELECT ON revocations   FROM hearme_web;
REVOKE SELECT ON registrations FROM hearme_web;
REVOKE SELECT ON self_nullifier_invalidations FROM hearme_web;
REVOKE SELECT ON self_chain_cursors           FROM hearme_web;

-- hearme_web: writes questions + askers (for the /ask form). Reads only
-- public result data. Raw envelopes / revocations / registrations remain
-- broker-private.
GRANT SELECT, INSERT          ON questions     TO hearme_web;
GRANT SELECT, INSERT          ON askers        TO hearme_web;
GRANT SELECT                  ON aggregates    TO hearme_web;

-- hearme_broker: owns the write path for everything the verification
-- pipeline produces. Reads questions to validate question_id/closes_at.
GRANT SELECT, INSERT, UPDATE  ON envelopes     TO hearme_broker;
GRANT SELECT, INSERT, UPDATE  ON aggregates    TO hearme_broker;
GRANT SELECT, INSERT          ON revocations   TO hearme_broker;
GRANT SELECT, INSERT, UPDATE  ON registrations TO hearme_broker;
GRANT SELECT, INSERT, UPDATE  ON self_nullifier_invalidations TO hearme_broker;
GRANT SELECT, INSERT, UPDATE  ON self_chain_cursors           TO hearme_broker;
GRANT SELECT, UPDATE          ON questions     TO hearme_broker;
GRANT SELECT                  ON askers        TO hearme_broker;
SQL
