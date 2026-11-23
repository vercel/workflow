-- experimental_rateLimit(): each key's next free slot (GCRA's `tat`), in
-- epoch microseconds, per app (`scope`, the World's base `jobPrefix`, which
-- keeps apps sharing a database apart). NULL is an idle key, the same as no
-- row: a reservation inserts the row before it locks it. `IF NOT EXISTS`
-- because two `bootstrap` processes started together can both apply a
-- migration.
CREATE TABLE IF NOT EXISTS "workflow"."workflow_rate_limits" (
	"scope" varchar NOT NULL,
	"key" varchar NOT NULL,
	"tat_us" bigint,
	CONSTRAINT "workflow_rate_limits_scope_key_pk" PRIMARY KEY("scope","key")
);
