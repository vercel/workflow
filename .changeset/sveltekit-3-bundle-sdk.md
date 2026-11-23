---
'@workflow/sveltekit': patch
---

Keep `workflow` and `@workflow/*` in the server bundle on SvelteKit 3, whose adapters otherwise leave them external, so a step can return the `Run` from `start()` again.
