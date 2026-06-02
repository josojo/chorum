CREATE TABLE IF NOT EXISTS "asker_admins" (
	"unique_identifier" text PRIMARY KEY NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Role privileges for this broker-owned table (hand-added; the CREATE above is
-- drizzle-generated — do not edit that part). Baseline tables get their grants in
-- db/init/02-roles.sh, but that runs at first-boot BEFORE delta migrations, so a
-- table added by a delta does not yet exist when it runs. Its grants therefore
-- travel with the migration: the migrator runs as the table owner (so it may
-- GRANT) on both fresh and existing volumes. Guarded on role existence so the
-- role-less test harness (tests/pg.ts applies these files raw) stays a no-op.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hearme_broker') THEN
		GRANT SELECT, INSERT, DELETE ON "asker_admins" TO hearme_broker;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hearme_web') THEN
		REVOKE SELECT ON "asker_admins" FROM hearme_web;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hearme_classifier') THEN
		REVOKE SELECT ON "asker_admins" FROM hearme_classifier;
	END IF;
END $$;
