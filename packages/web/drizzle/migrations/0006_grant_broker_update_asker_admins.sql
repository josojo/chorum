-- Grant hearme_broker UPDATE on asker_admins.
--
-- The admin CLI's `grant` upserts via INSERT ... ON CONFLICT DO UPDATE (so a
-- re-grant refreshes the label — see grantAskerAdmin in broker queries.ts).
-- Postgres checks the UPDATE privilege when PLANNING an ON CONFLICT DO UPDATE,
-- regardless of whether a row actually conflicts, so without UPDATE even the
-- first insert of a new admin fails with "permission denied for table
-- asker_admins". 0004 granted only SELECT, INSERT, DELETE; this adds the
-- missing UPDATE. Hand-authored (no schema change), guarded on role existence
-- so the role-less test harness (tests/pg.ts applies these files raw) is a
-- no-op.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hearme_broker') THEN
		GRANT UPDATE ON "asker_admins" TO hearme_broker;
	END IF;
END $$;
