---
"@workflow/builders": patch
---

Register `Run`'s steps in projects that depend on `workflow` but cannot resolve `@workflow/core` themselves, as with pnpm. The steps bundle used to leave them out while the workflow bundle could still call them.
