---
"@workflow/errors": patch
"@workflow/core": patch
"workflow": patch
---

Polish rendering of in/out-of-context errors: drop `functionName` leak from the inspected error object, simplify the docs link framing to a single `docs: <url>` line, and redirect the stack trace to the user's call site (via `Error.captureStackTrace`) so terminal overlays point at user code instead of framework internals
