---
"@workflow/core": patch
"workflow": patch
---

Fix double-framing when a `WritableStream` is forwarded across `start()`. A workflow's `getWritable()` handle (or a step-context `getWritable()`) can now be passed as a workflow argument to a child workflow; the child's writes land on the parent's stream as raw chunks instead of devalue-encoded frames.
