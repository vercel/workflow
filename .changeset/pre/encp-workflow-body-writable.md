---
'@workflow/core': patch
---

Seal forwarded writes to streams taken with `getWritable()` in a workflow body, which previously fell back to fetching the owner's symmetric key because the workflow VM has no key material to publish on the handle.
