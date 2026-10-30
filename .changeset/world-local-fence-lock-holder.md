---
"@workflow/world-local": patch
---

The in-band fence lock names the process that holds it, so when that process is killed, the next in-band write on the same machine takes the lock at once instead of waiting 30 seconds for it to go stale.
