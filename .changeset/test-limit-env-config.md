---
'@workflow/core': minor
'@workflow/world-vercel': minor
'@workflow/world': minor
---

Make runtime tuning constants (timeouts, retry counts, stream buffering/reconnect) configurable via `WORKFLOW_*` environment variables, and forward `WORKFLOW_TEST_LIMIT_OVERRIDES` to the backend as a request header so a deployment can tighten server-side limits for testing.
