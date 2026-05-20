-- Role grants for hearme v0.
-- Runs after 01-schema.sql (numbered ordering in /docker-entrypoint-initdb.d).
--
-- Enforcement boundary (ARCHITECTURE.md §2, §4):
--   hearme_web    — writes questions only; reads public aggregates.
--   hearme_broker — writes envelopes, aggregates, revocations, nullifiers; reads questions, askers.
--
-- Passwords here are dev-only. Production deploys must override these
-- via secrets injection before the init script runs.

CREATE ROLE hearme_web    LOGIN PASSWORD 'hearme_web_dev';
CREATE ROLE hearme_broker LOGIN PASSWORD 'hearme_broker_dev';

GRANT USAGE ON SCHEMA public TO hearme_web, hearme_broker;

-- Defensive revokes so the intended privacy boundary is visible in the grant
-- script, even if a previous local database allowed these reads. The
-- nullifier registry binds passport-derived identity to an agent_key; that's
-- broker-internal verification state and never crosses to the web tier.
REVOKE SELECT ON envelopes   FROM hearme_web;
REVOKE SELECT ON revocations FROM hearme_web;
REVOKE SELECT ON nullifiers  FROM hearme_web;

-- hearme_web: writes questions + askers (for the /ask form). Reads only
-- public result data. Raw envelopes / revocations / nullifiers remain
-- broker-private.
GRANT SELECT, INSERT          ON questions   TO hearme_web;
GRANT SELECT, INSERT          ON askers      TO hearme_web;
GRANT SELECT                  ON aggregates  TO hearme_web;

-- hearme_broker: owns the write path for everything the verification
-- pipeline produces. Reads questions to validate question_id/closes_at.
GRANT SELECT, INSERT, UPDATE  ON envelopes   TO hearme_broker;
GRANT SELECT, INSERT, UPDATE  ON aggregates  TO hearme_broker;
GRANT SELECT, INSERT          ON revocations TO hearme_broker;
GRANT SELECT, INSERT, UPDATE  ON nullifiers  TO hearme_broker;
GRANT SELECT, UPDATE          ON questions   TO hearme_broker;
GRANT SELECT                  ON askers      TO hearme_broker;
