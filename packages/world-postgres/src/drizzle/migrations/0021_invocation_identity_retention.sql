ALTER TABLE "workflow"."workflow_events" ADD COLUMN "resume_id" varchar;
--> statement-breakpoint
ALTER TABLE "workflow"."workflow_events" ADD COLUMN "resume_payload_digest" varchar;
--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_events_hook_resume_unique" ON "workflow"."workflow_events" ("run_id", "resume_id") WHERE "type" = 'hook_received' AND "resume_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "workflow"."workflow_invocations" ALTER COLUMN "payload" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "workflow"."workflow_invocations" ALTER COLUMN "fingerprint" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "workflow"."workflow_invocations" ADD COLUMN "expired_at" timestamp;
--> statement-breakpoint
UPDATE "workflow"."workflow_invocations" AS invocation
SET "payload" = NULL, "result" = NULL, "fingerprint" = NULL,
    "expired_at" = coalesce(invocation.expired_at, run.expired_at, now())
FROM "workflow"."workflow_runs" AS run
WHERE invocation.run_id = run.id
  AND (run.expired_at IS NOT NULL OR
       (run.status IN ('completed', 'failed', 'cancelled') AND run.attributes -> '$retention' = '"0"'::jsonb));
