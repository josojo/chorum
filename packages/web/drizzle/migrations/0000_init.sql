CREATE TABLE IF NOT EXISTS "aggregates" (
	"question_id" uuid PRIMARY KEY NOT NULL,
	"total_answers" integer DEFAULT 0 NOT NULL,
	"by_predicate" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "askers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "envelopes" (
	"question_id" uuid NOT NULL,
	"unique_identifier" text NOT NULL,
	"answer" text NOT NULL,
	"disclosed_predicates" jsonb NOT NULL,
	"agent_signature" text NOT NULL,
	"delegation_hash" text NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "envelopes_question_id_unique_identifier_pk" PRIMARY KEY("question_id","unique_identifier")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asker_id" uuid,
	"text" text NOT NULL,
	"topic" text,
	"nonce" text DEFAULT encode(gen_random_bytes(16), 'base64') NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closes_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"options" jsonb DEFAULT '["yes","no"]'::jsonb NOT NULL,
	"scope" text DEFAULT 'worldwide' NOT NULL,
	"country" text,
	"continent" text,
	CONSTRAINT "questions_status_chk" CHECK ("questions"."status" IN ('open', 'closed')),
	CONSTRAINT "questions_scope_chk" CHECK ("questions"."scope" IN ('worldwide','continent','country')),
	CONSTRAINT "questions_options_chk" CHECK (jsonb_typeof("questions"."options") = 'array' AND jsonb_array_length("questions"."options") BETWEEN 2 AND 8),
	CONSTRAINT "questions_continent_chk" CHECK ("questions"."continent" IS NULL OR "questions"."continent" IN ('AF','AN','AS','EU','NA','OC','SA')),
	CONSTRAINT "questions_scope_geo_chk" CHECK (("questions"."scope" = 'worldwide' AND "questions"."country" IS NULL AND "questions"."continent" IS NULL)
        OR ("questions"."scope" = 'continent' AND "questions"."country" IS NULL AND "questions"."continent" IS NOT NULL)
        OR ("questions"."scope" = 'country' AND "questions"."country" IS NOT NULL AND "questions"."continent" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "registrations" (
	"unique_identifier" text PRIMARY KEY NOT NULL,
	"agent_key" text NOT NULL,
	"disclosed_predicates" jsonb NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "revocations" (
	"delegation_hash" text PRIMARY KEY NOT NULL,
	"revoked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "self_chain_cursors" (
	"name" text PRIMARY KEY NOT NULL,
	"last_block" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "self_nullifier_invalidations" (
	"unique_identifier" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"chain_id" text,
	"block_number" bigint NOT NULL,
	"log_index" integer NOT NULL,
	"tx_hash" text NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "aggregates" ADD CONSTRAINT "aggregates_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "envelopes" ADD CONSTRAINT "envelopes_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "questions" ADD CONSTRAINT "questions_asker_id_askers_id_fk" FOREIGN KEY ("asker_id") REFERENCES "public"."askers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "envelopes_question_id_idx" ON "envelopes" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "envelopes_submitted_at_idx" ON "envelopes" USING btree ("submitted_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "questions_scope_idx" ON "questions" USING btree ("scope");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "questions_country_idx" ON "questions" USING btree ("country");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "questions_continent_idx" ON "questions" USING btree ("continent");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "registrations_agent_key_idx" ON "registrations" USING btree ("agent_key");