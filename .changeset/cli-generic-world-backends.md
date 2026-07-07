---
'@workflow/cli': patch
---

Restore support for community world packages in CLI world initialization. Since static world-target injection, the CLI only constructed the vercel, local, and postgres worlds and threw "Unsupported workflow backend" for anything else. Backends other than vercel/local are now resolved from the user's project directory and loaded via their `createWorld()` export (the same approach as `@workflow/web`), so third-party worlds like `@workflow-worlds/*` work again with `workflow inspect`/`workflow web`.
