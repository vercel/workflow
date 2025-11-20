-- Convert JSONB to bytea by serializing to text and encoding as UTF-8
ALTER TABLE "workflow"."workflow_events" ALTER COLUMN "payload" SET DATA TYPE bytea USING convert_to("payload"::text, 'UTF8');--> statement-breakpoint
ALTER TABLE "workflow"."workflow_hooks" ALTER COLUMN "metadata" SET DATA TYPE bytea USING convert_to("metadata"::text, 'UTF8');--> statement-breakpoint
ALTER TABLE "workflow"."workflow_runs" ALTER COLUMN "output" SET DATA TYPE bytea USING convert_to("output"::text, 'UTF8');--> statement-breakpoint
ALTER TABLE "workflow"."workflow_runs" ALTER COLUMN "input" SET DATA TYPE bytea USING convert_to("input"::text, 'UTF8');--> statement-breakpoint
ALTER TABLE "workflow"."workflow_steps" ALTER COLUMN "input" SET DATA TYPE bytea USING convert_to("input"::text, 'UTF8');--> statement-breakpoint
ALTER TABLE "workflow"."workflow_steps" ALTER COLUMN "output" SET DATA TYPE bytea USING convert_to("output"::text, 'UTF8');