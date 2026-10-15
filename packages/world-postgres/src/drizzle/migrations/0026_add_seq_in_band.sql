-- The in-band writer fence for single-orchestrator runs: how many positions
-- the run's orchestrator writes have been accepted for, `run_created`
-- included. Every existing run starts at 1, the value a run with no fenced
-- write has; only single-orchestrator runs ever advance it.
ALTER TABLE "workflow"."workflow_event_slots" ADD COLUMN IF NOT EXISTS "seq_in_band" integer DEFAULT 1 NOT NULL;
