---
'@workflow/core': patch
---

`Run.returnValue` does not count a wait that failed with a transient World error toward `WORKFLOW_RETURN_VALUE_MAX_LONG_POLLS`.
