---
"@workflow/core": minor
"@workflow/world": minor
"@workflow/errors": minor
"@workflow/world-vercel": minor
"@workflow/world-local": minor
"@workflow/world-postgres": minor
"@workflow/world-testing": patch
"@workflow/web-shared": patch
"workflow": minor
---

Spec 9 runs use a single orchestrator: steps retry in place on one queue message, `maxRetries: 0` steps run at most once per live owner, and a World that declares spec 9 must implement the in-band writer fence. Spec 8 runs keep the previous orchestrator; `WORKFLOW_SPEC_VERSION=8` creates spec 8 runs.
