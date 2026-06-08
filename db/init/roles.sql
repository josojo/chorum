-- Canonical role + grant definition for the shared Postgres.
--
-- Single source of truth for the privacy/authority boundary between the web,
-- broker, and classifier tiers (ARCHITECTURE_V0.md §4). Applied by:
--   - db/init/02-roles.sh        — local/dev & container-DB deploys, via the
--                                  postgres docker-entrypoint-initdb.d step.
--   - scripts/bootstrap-rds.sh   — managed-Postgres (RDS) deploys, where there
--                                  is no docker entrypoint to run the init dir.
-- CI guards the resulting grants in scripts/verify-db.sh (ci.yml `db` job), so
-- this file is the one place to change a boundary.
--
-- Must be run with psql (uses \gexec) by an admin/superuser role, AFTER the
-- schema exists (the GRANTs reference tables). Required psql variables:
--   -v web_password=...  -v broker_password=...  -v classifier_password=...
-- The admin role's own password is NOT managed here — it is set at DB creation
-- (POSTGRES_PASSWORD locally, the RDS master password under managed Postgres).

SELECT format('CREATE ROLE chorum_web LOGIN PASSWORD %L', :'web_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chorum_web')\gexec

SELECT format('CREATE ROLE chorum_broker LOGIN PASSWORD %L', :'broker_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chorum_broker')\gexec

SELECT format('CREATE ROLE chorum_classifier LOGIN PASSWORD %L', :'classifier_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chorum_classifier')\gexec

ALTER ROLE chorum_web        WITH LOGIN PASSWORD :'web_password';
ALTER ROLE chorum_broker     WITH LOGIN PASSWORD :'broker_password';
ALTER ROLE chorum_classifier WITH LOGIN PASSWORD :'classifier_password';

GRANT USAGE ON SCHEMA public TO chorum_web, chorum_broker, chorum_classifier;

-- Defensive revokes so the intended privacy boundary is visible in the grant
-- script, even if a previous database allowed these reads. The registrations
-- registry binds passport-derived identity to an agent_key; that's
-- broker-internal verification state and never crosses to the web tier.
REVOKE SELECT ON envelopes     FROM chorum_web;
REVOKE SELECT ON revocations   FROM chorum_web;
REVOKE SELECT ON registrations FROM chorum_web;
REVOKE SELECT ON self_nullifier_invalidations FROM chorum_web;
REVOKE SELECT ON self_chain_cursors           FROM chorum_web;

-- chorum_web: writes questions + askers (for the /ask form). Reads only
-- public result data. Raw envelopes / revocations / registrations remain
-- broker-private. NOTE: chorum_web is NOT granted UPDATE on questions —
-- topic assignment is owned by chorum_classifier, not the asker.
GRANT SELECT, INSERT          ON questions     TO chorum_web;
GRANT SELECT, INSERT          ON askers        TO chorum_web;
GRANT SELECT                  ON aggregates    TO chorum_web;

-- chorum_broker: owns the write path for everything the verification
-- pipeline produces. Reads questions to validate question_id/closes_at.
GRANT SELECT, INSERT, UPDATE  ON envelopes     TO chorum_broker;
GRANT SELECT, INSERT, UPDATE  ON aggregates    TO chorum_broker;
GRANT SELECT, INSERT          ON revocations   TO chorum_broker;
GRANT SELECT, INSERT, UPDATE  ON registrations TO chorum_broker;
GRANT SELECT, INSERT, UPDATE  ON self_nullifier_invalidations TO chorum_broker;
GRANT SELECT, INSERT, UPDATE  ON self_chain_cursors           TO chorum_broker;
GRANT SELECT, UPDATE          ON questions     TO chorum_broker;
GRANT SELECT                  ON askers        TO chorum_broker;

-- chorum_classifier: reads NULL-topic open questions, writes the topic
-- column. Nothing else. Column-level UPDATE means a compromise of the
-- classifier credentials can ONLY mislabel topics — it cannot edit text,
-- options, close-times, or any other question field, and cannot read or
-- write envelopes / registrations.
REVOKE SELECT ON envelopes                    FROM chorum_classifier;
REVOKE SELECT ON revocations                  FROM chorum_classifier;
REVOKE SELECT ON registrations                FROM chorum_classifier;
REVOKE SELECT ON self_nullifier_invalidations FROM chorum_classifier;
REVOKE SELECT ON self_chain_cursors           FROM chorum_classifier;
REVOKE SELECT ON aggregates                   FROM chorum_classifier;
REVOKE SELECT ON askers                       FROM chorum_classifier;
GRANT  SELECT                 ON questions        TO chorum_classifier;
GRANT  UPDATE (topic)         ON questions        TO chorum_classifier;
