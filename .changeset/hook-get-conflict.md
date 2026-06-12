---
"@workflow/core": minor
"workflow": minor
---

Add `hook.getConflict()`, a method returning a promise that suspends the workflow to commit hook registration and resolves with the conflicting `Run` when another active hook owns the token (or `null` once the hook is registered), without waiting for hook payload data.
