CREATE TYPE "public"."wait_status" AS ENUM('waiting', 'completed');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow"."workflow_waits" (
	"wait_id" varchar PRIMARY KEY NOT NULL,
	"run_id" varchar NOT NULL,
	"status" "wait_status" NOT NULL,
	"resume_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"spec_version" integer
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_waits_run_id_index" ON "workflow"."workflow_waits" USING btree ("run_id");
