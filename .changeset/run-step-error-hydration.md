---
"@workflow/core": major
"@workflow/errors": major
"@workflow/world": major
"@workflow/world-local": major
"@workflow/world-postgres": major
"@workflow/world-vercel": major
---

**BREAKING CHANGE**: Run and step errors are now serialized through the workflow serialization pipeline, preserving original class identity and cause chains on `WorkflowRunFailedError.cause`. Pre-upgrade failed runs in the `world-postgres` legacy `error` text column surface as `error: undefined` on read; the original payload is still readable directly from the `errorJson` column for manual inspection.
