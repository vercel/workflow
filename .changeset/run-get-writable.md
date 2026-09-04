---
'@workflow/core': minor
'workflow': minor
---

Add `Run#getWritable()`, which opens a writable onto an existing run's stream from its run ID so one run can append to a stream another run owns.
