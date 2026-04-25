---
"@workflow/core": major
"@workflow/errors": major
"@workflow/world": major
"@workflow/world-local": major
"@workflow/world-postgres": major
"@workflow/world-vercel": major
---

**BREAKING CHANGE**: Run and step errors are now serialized through the workflow serialization pipeline, preserving original class identity and cause chains on `WorkflowRunFailedError.cause`.
