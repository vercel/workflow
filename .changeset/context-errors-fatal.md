---
"@workflow/errors": patch
"@workflow/core": patch
---

`FatalError.is(err)` now recognizes any error with a `fatal: true` own property, and context-violation errors set `fatal = true`. Calling a workflow-only API from the wrong context now fails the step immediately instead of burning three retry attempts on a guaranteed-to-fail error.
