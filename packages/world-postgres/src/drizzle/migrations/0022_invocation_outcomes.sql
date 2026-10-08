-- Distinguish arbitrary legacy return values from versioned outcome envelopes.
ALTER TABLE "workflow"."workflow_invocations"
  ADD COLUMN IF NOT EXISTS "result_version" integer NOT NULL DEFAULT 0;
