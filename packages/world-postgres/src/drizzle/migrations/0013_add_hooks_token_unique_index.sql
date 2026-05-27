DROP INDEX IF EXISTS "workflow"."workflow_hooks_token_index";
--> statement-breakpoint
WITH "ranked_workflow_hooks" AS (
	SELECT
		ctid,
		ROW_NUMBER() OVER (
			PARTITION BY "token"
			ORDER BY "created_at", ctid
		) AS "row_num"
	FROM "workflow"."workflow_hooks"
)
DELETE FROM "workflow"."workflow_hooks"
WHERE ctid IN (
	SELECT ctid
	FROM "ranked_workflow_hooks"
	WHERE "row_num" > 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_hooks_token_unique"
	ON "workflow"."workflow_hooks" ("token");
