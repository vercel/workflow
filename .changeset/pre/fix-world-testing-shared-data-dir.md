---
"@workflow/world-testing": patch
---

Fix flaky Local World tests caused by concurrent test servers sharing one data directory and re-enqueuing each other's in-flight runs on startup
