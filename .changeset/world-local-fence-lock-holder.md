---
"@workflow/world-local": patch
---

The in-band fence lock names the process that holds it, so when that process is killed, the next in-band write on the same machine takes the lock at once instead of waiting 30 seconds for it to go stale. An older world-local cannot remove such a lock, so after a downgrade, in-band writes to a run whose writer was killed holding it fail until a newer world-local writes that run.
