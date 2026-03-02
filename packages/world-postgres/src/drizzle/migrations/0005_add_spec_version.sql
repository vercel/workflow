ALTER TABLE "workflow"."workflow_runs" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."status";--> statement-breakpoint
CREATE TYPE "public"."status" AS ENUM('pending', 'running', 'completed', 'failed', 'cancelled');--> statement-breakpoint
ALTER TABLE "workflow"."workflow_runs" ALTER COLUMN "status" SET DATA TYPE "public"."status" USING "status"::"public"."status";--> statement-breakpoint
ALTER TABLE "workflow"."workflow_runs" ADD COLUMN "spec_version" varchar;