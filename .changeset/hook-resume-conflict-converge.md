---
'@workflow/core': patch
---

Sequential hook resume no longer treats a conflict (409) on the `hook_received` write as "hook gone": when the run is still live it publishes the wake and reports success, so a durably-committed resume can no longer be lost behind a spurious `HookNotFoundError`.
