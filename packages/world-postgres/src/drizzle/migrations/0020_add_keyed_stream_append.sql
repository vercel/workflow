ALTER TABLE "workflow"."workflow_stream_chunks" ADD COLUMN IF NOT EXISTS "idempotency_key" varchar;--> statement-breakpoint
ALTER TABLE "workflow"."workflow_stream_chunks" ADD COLUMN IF NOT EXISTS "semantic_digest" varchar;--> statement-breakpoint
ALTER TABLE "workflow"."workflow_stream_chunks" ADD COLUMN IF NOT EXISTS "stream_index" integer;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_stream_chunks_keyed_append_idx" ON "workflow"."workflow_stream_chunks" ("run_id","stream_id","idempotency_key") WHERE "idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_stream_chunks_keyed_index_idx" ON "workflow"."workflow_stream_chunks" ("run_id","stream_id","stream_index") WHERE "stream_index" IS NOT NULL;
