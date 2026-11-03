---
"@workflow/core": minor
"@workflow/world": minor
"@workflow/world-vercel": minor
"workflow": minor
---

Remove opt-out environment variables for runtime behavior that has been the default for a while: `WORKFLOW_INLINE_EARLY_ADVANCE`, `WORKFLOW_RETURN_VALUE_LONG_POLL`, `WORKFLOW_SLOT_GAP_CHECK`, `WORKFLOW_LOG_ORDER_DRAWS`, `WORKFLOW_INLINE_OWNERSHIP` and `WORKFLOW_BATCH_TRANSITIONS` are no longer read, and the behavior they could switch off is always on. `WORKFLOW_SEALED_LOG` (deprecated) is no longer read either, and `@workflow/world` no longer exports `SEALED_LOG_ENV_VAR`: set `WORKFLOW_SPEC_VERSION=6` to create new runs without the sealed log.
