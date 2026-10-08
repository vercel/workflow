CREATE TABLE "workflow"."workflow_invocations" (
  "sequence" bigserial NOT NULL,
  "run_id" varchar NOT NULL,
  "request_id" varchar NOT NULL,
  "payload" bytea NOT NULL,
  "fingerprint" varchar NOT NULL,
  "result" bytea,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "responded_at" timestamp,
  PRIMARY KEY ("run_id", "request_id")
);
--> statement-breakpoint
CREATE INDEX "workflow_invocations_pending" ON "workflow"."workflow_invocations" ("run_id", "sequence") WHERE "responded_at" IS NULL;
