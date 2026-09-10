---
'@workflow/core': minor
---

Stamp the creating client's environment into the queue message's `runInput`, and refuse a queue delivery whose run was created in a different environment than the consuming deployment runs in, so one run ID can no longer be forked into two environments.
