---
'@workflow/core': patch
'@workflow/web-shared': patch
---

Fix o11y display of `step_retrying` / `step_failed` errors so hydrated errors show message/stack instead of raw `Uint8Array` bytes.
