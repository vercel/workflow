---
"@workflow/core": minor
"@workflow/world": minor
"@workflow/world-vercel": minor
"@workflow/world-local": minor
"@workflow/world-postgres": minor
"workflow": minor
---

Remove opt-out and test-only environment variables that are no longer needed. The runtime no longer reads `WORKFLOW_INLINE_EARLY_ADVANCE`, `WORKFLOW_RETURN_VALUE_LONG_POLL`, `WORKFLOW_SLOT_GAP_CHECK`, `WORKFLOW_LOG_ORDER_DRAWS`, `WORKFLOW_INLINE_OWNERSHIP` or `WORKFLOW_BATCH_TRANSITIONS`, and the behavior they could switch off is always on. `WORKFLOW_SEALED_LOG` (deprecated) is no longer read, and `@workflow/world` no longer exports `SEALED_LOG_ENV_VAR`: set `WORKFLOW_SPEC_VERSION=6` to create new runs without the sealed log. The Vercel World no longer reads `WORKFLOW_MAX_CHUNKS_PER_REQUEST` or `WORKFLOW_TEST_LIMIT_OVERRIDES`, and the Local and Postgres Worlds no longer read `WORKFLOW_LOCAL_RUN_STATUS_POLL_INTERVAL_MS` and `WORKFLOW_POSTGRES_RUN_STATUS_POLL_INTERVAL_MS`.
