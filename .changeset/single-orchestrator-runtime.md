---
"@workflow/core": minor
"@workflow/world": minor
"@workflow/errors": minor
"@workflow/world-vercel": minor
"@workflow/world-local": minor
"@workflow/world-postgres": minor
"@workflow/web-shared": patch
"workflow": minor
---

Spec 9 runs use a single orchestrator: steps retry in place on one queue message and `maxRetries: 0` steps run at most once. Spec 8 runs keep the previous orchestrator and its settings; `WORKFLOW_SPEC_VERSION=8` creates spec 8 runs.
