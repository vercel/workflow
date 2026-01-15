ALTER TABLE "workflow"."workflow_runs" ADD COLUMN "error_cbor" bytea;--> statement-breakpoint
ALTER TABLE "workflow"."workflow_steps" ADD COLUMN "error_cbor" bytea;--> statement-breakpoint
ALTER TABLE "workflow"."workflow_steps" ADD COLUMN "spec_version" integer;--> statement-breakpoint
ALTER TABLE "workflow"."workflow_hooks" ADD COLUMN "spec_version" integer;--> statement-breakpoint
ALTER TABLE "workflow"."workflow_events" ADD COLUMN "spec_version" integer;
