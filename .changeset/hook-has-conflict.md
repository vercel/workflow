---
"@workflow/core": minor
"workflow": minor
---

Add `hook.hasConflict`, a `Promise<boolean>` that suspends the workflow to commit hook registration and resolves with whether the token is already owned by another active hook, without waiting for hook payload data.
