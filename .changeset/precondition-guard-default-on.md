---
"workflow": minor
"@workflow/core": minor
"@workflow/builders": patch
"@workflow/world-vercel": patch
"@workflow/world": patch
"@workflow/errors": patch
---

The `WORKFLOW_PRECONDITION_GUARD` event-creation guard is now on by default; opt out with `WORKFLOW_PRECONDITION_GUARD=0`. Boolean workflow environment variables now accept the common truthy/falsy spellings (`1`/`true`/`yes`/`on`, `0`/`false`/`no`/`off`) rather than only `1`.
