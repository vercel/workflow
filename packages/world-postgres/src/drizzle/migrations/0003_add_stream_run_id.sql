ALTER TABLE "workflow"."workflow_stream_chunks" ADD COLUMN "run_id" varchar;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_stream_chunks_run_id_index" ON "workflow"."workflow_stream_chunks" USING btree ("run_id");

