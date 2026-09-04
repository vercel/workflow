---
'@workflow/core': patch
---

Build the workflow entrypoint's queue handler from the runtime World (`getWorld()`) instead of `getWorldHandlers()`, so a process creates one World rather than two. A stateful World no longer gets duplicate connection pools or queue workers.
