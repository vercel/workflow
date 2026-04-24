---
"@workflow/core": patch
---

Polish context-violation rendering: drop the `functionName` enumerable leak from the inspected error object, simplify the docs line to `docs: <url>`, and redirect the stack to the user's call site via `Error.captureStackTrace` so terminal overlays point at user code instead of framework internals.
