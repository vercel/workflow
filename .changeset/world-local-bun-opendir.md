---
'@workflow/world-local': patch
---

Fix `initDataDir()` crashing on Bun for a new data directory: Bun's `opendir()` reports a missing directory on the first read, not when it is opened.
