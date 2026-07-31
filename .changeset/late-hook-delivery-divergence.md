---
'@workflow/core': patch
'workflow': patch
---

Stop failing runs with a corrupted-event-log error when a hook delivery arrives after the hook was disposed, or when a step result is still being fetched
