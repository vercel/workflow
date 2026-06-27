CREATE TABLE IF NOT EXISTS "workflow"."workflow_hook_claims" (
	"token" varchar PRIMARY KEY NOT NULL,
	"run_id" varchar NOT NULL,
	"hook_id" varchar,
	"phase" varchar NOT NULL,
	"ttl_seconds" integer NOT NULL,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_hook_claims_run_id_index" ON "workflow"."workflow_hook_claims" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_hook_claims_expires_at_index" ON "workflow"."workflow_hook_claims" USING btree ("expires_at");
