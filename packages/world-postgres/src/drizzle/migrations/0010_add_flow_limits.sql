CREATE TABLE "workflow"."workflow_limit_keys" (
	"limit_key" varchar PRIMARY KEY NOT NULL,
	"concurrency_max" integer,
	"rate_count" integer,
	"rate_period_ms" integer
);
--> statement-breakpoint
CREATE TABLE "workflow"."workflow_limit_leases" (
	"lease_id" varchar PRIMARY KEY NOT NULL,
	"limit_key" varchar NOT NULL,
	"holder_id" varchar NOT NULL,
	"acquired_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "workflow"."workflow_limit_waiters" (
	"waiter_id" varchar PRIMARY KEY NOT NULL,
	"limit_key" varchar NOT NULL,
	"holder_id" varchar NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"lease_ttl_ms" integer
);
--> statement-breakpoint
CREATE TABLE "workflow"."workflow_rate_limit_tokens" (
	"token_id" varchar PRIMARY KEY NOT NULL,
	"limit_key" varchar NOT NULL,
	"holder_id" varchar NOT NULL,
	"acquired_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow"."workflow_limit_leases" ADD CONSTRAINT "workflow_limit_leases_limit_key_workflow_limit_keys_limit_key_fk" FOREIGN KEY ("limit_key") REFERENCES "workflow"."workflow_limit_keys"("limit_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow"."workflow_limit_waiters" ADD CONSTRAINT "workflow_limit_waiters_limit_key_workflow_limit_keys_limit_key_fk" FOREIGN KEY ("limit_key") REFERENCES "workflow"."workflow_limit_keys"("limit_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow"."workflow_rate_limit_tokens" ADD CONSTRAINT "workflow_rate_limit_tokens_limit_key_workflow_limit_keys_limit_key_fk" FOREIGN KEY ("limit_key") REFERENCES "workflow"."workflow_limit_keys"("limit_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_limit_leases_limit_key_holder_id_index" ON "workflow"."workflow_limit_leases" USING btree ("limit_key","holder_id");--> statement-breakpoint
CREATE INDEX "workflow_limit_leases_limit_key_expires_at_index" ON "workflow"."workflow_limit_leases" USING btree ("limit_key","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_limit_waiters_limit_key_holder_id_index" ON "workflow"."workflow_limit_waiters" USING btree ("limit_key","holder_id");--> statement-breakpoint
CREATE INDEX "workflow_limit_waiters_limit_key_created_at_index" ON "workflow"."workflow_limit_waiters" USING btree ("limit_key","created_at");--> statement-breakpoint
CREATE INDEX "workflow_rate_limit_tokens_limit_key_expires_at_index" ON "workflow"."workflow_rate_limit_tokens" USING btree ("limit_key","expires_at");--> statement-breakpoint
