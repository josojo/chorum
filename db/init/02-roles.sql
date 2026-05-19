-- Role grants for hearme v0.
-- Runs after 01-schema.sql (numbered ordering in /docker-entrypoint-initdb.d).
--
-- Enforcement boundary (ARCHITECTURE.md §2, §4):
--   hearme_web    — writes questions only; reads everything.
--   hearme_broker — writes envelopes, aggregates, revocations; reads questions, askers.
--
-- Passwords here are dev-only. Production deploys must override these
-- via secrets injection before the init script runs.

CREATE ROLE hearme_web    LOGIN PASSWORD 'hearme_web_dev';
CREATE ROLE hearme_broker LOGIN PASSWORD 'hearme_broker_dev';

GRANT USAGE ON SCHEMA public TO hearme_web, hearme_broker;

-- hearme_web: writes questions + askers (for the /ask form). Reads everything
-- it needs to render the public pages.
GRANT SELECT, INSERT          ON questions   TO hearme_web;
GRANT SELECT, INSERT          ON askers      TO hearme_web;
GRANT SELECT                  ON envelopes   TO hearme_web;
GRANT SELECT                  ON aggregates  TO hearme_web;
GRANT SELECT                  ON revocations TO hearme_web;

-- hearme_broker: owns the write path for everything the verification
-- pipeline produces. Reads questions to validate question_id/closes_at.
GRANT SELECT, INSERT, UPDATE  ON envelopes   TO hearme_broker;
GRANT SELECT, INSERT, UPDATE  ON aggregates  TO hearme_broker;
GRANT SELECT, INSERT          ON revocations TO hearme_broker;
GRANT SELECT, UPDATE          ON questions   TO hearme_broker;
GRANT SELECT                  ON askers      TO hearme_broker;
