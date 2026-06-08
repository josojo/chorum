CREATE TABLE IF NOT EXISTS "board_members" (
	"unique_identifier" text PRIMARY KEY NOT NULL,
	"gov_key" text NOT NULL,
	"tier" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "referral_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"referrer_nullifier" text NOT NULL,
	"max_uses" integer DEFAULT 1 NOT NULL,
	"used_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "referrals" (
	"referee_nullifier" text PRIMARY KEY NOT NULL,
	"referrer_nullifier" text NOT NULL,
	"code_hash" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	CONSTRAINT "referrals_state_check" CHECK ("referrals"."state" IN ('pending', 'active'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reputation" (
	"unique_identifier" text PRIMARY KEY NOT NULL,
	"referrals_active" integer DEFAULT 0 NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"tier" text DEFAULT 'none' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "board_members_gov_key_idx" ON "board_members" USING btree ("gov_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "referral_codes_referrer_idx" ON "referral_codes" USING btree ("referrer_nullifier");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "referrals_referrer_idx" ON "referrals" USING btree ("referrer_nullifier");--> statement-breakpoint
-- Role privileges for the referral/reputation/board tables (REFERRALS.md §5).
-- The CREATEs above are drizzle-generated — do NOT edit those. These grants are
-- hand-added and travel with the migration (the same pattern as 0004): baseline
-- grants in db/init/02-roles.sh run at first-boot BEFORE delta migrations, so a
-- table a delta creates does not yet exist when that runs. The migrator runs as
-- the table owner, so it may GRANT here, on both fresh and existing volumes.
-- These four tables are broker-PRIVATE: they bind passport-derived nullifiers to
-- referral edges, reputation, and governance keys — broker-internal state that
-- never crosses to the web or classifier tiers. Guarded on role existence so the
-- role-less test harness (tests/pg.ts applies these files raw) stays a no-op.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chorum_broker') THEN
		GRANT SELECT, INSERT, UPDATE ON "referral_codes" TO chorum_broker;
		GRANT SELECT, INSERT, UPDATE ON "referrals"      TO chorum_broker;
		GRANT SELECT, INSERT, UPDATE ON "reputation"     TO chorum_broker;
		GRANT SELECT, INSERT, UPDATE ON "board_members"  TO chorum_broker;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chorum_web') THEN
		REVOKE SELECT ON "referral_codes" FROM chorum_web;
		REVOKE SELECT ON "referrals"      FROM chorum_web;
		REVOKE SELECT ON "reputation"     FROM chorum_web;
		REVOKE SELECT ON "board_members"  FROM chorum_web;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chorum_classifier') THEN
		REVOKE SELECT ON "referral_codes" FROM chorum_classifier;
		REVOKE SELECT ON "referrals"      FROM chorum_classifier;
		REVOKE SELECT ON "reputation"     FROM chorum_classifier;
		REVOKE SELECT ON "board_members"  FROM chorum_classifier;
	END IF;
END $$;