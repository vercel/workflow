---
'@workflow/cli': patch
---

Add `--since`/`--until` to `workflow inspect runs`; `workflow start` and bulk `workflow cancel` name lookups now search past the backend's default 24h window.
