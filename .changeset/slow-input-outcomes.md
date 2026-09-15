---
"@workflow/world": minor
"@workflow/errors": minor
"@workflow/world-postgres": patch
"@workflow/core": patch
---

Replay inputs that finish during executor shutdown before acknowledging their wake. Persist versioned invocation success/error outcomes and restore known Workflow errors to callers, preserving legacy stored result values.
