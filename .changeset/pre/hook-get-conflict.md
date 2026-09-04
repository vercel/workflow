---
"@workflow/core": minor
"workflow": minor
---

Replace `hook.hasConflict` (a `Promise<boolean>` property) with `hook.getConflict()`, a method returning a promise that suspends the workflow to commit hook registration and resolves with the conflicting `Run` when another active hook owns the token (or `null` once the hook is registered), without waiting for hook payload data. Code using `await hook.hasConflict` should migrate to `const conflict = await hook.getConflict()` and branch on `conflict !== null`.
