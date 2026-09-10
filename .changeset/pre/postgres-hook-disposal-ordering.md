---
'@workflow/world-postgres': patch
---

Reject a hook resume that races the hook's disposal, instead of journaling it after `hook_disposed` and corrupting the owning run's event log.
