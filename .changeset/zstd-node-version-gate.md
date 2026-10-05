---
'@workflow/core': patch
'@workflow/world': patch
---

Fix cross-deployment hook resumes and starts writing zstd payloads to runs on Node.js versions that cannot decode them. Required for upgrading to a newer Node.js version while existing runs on older Node.js versions are still receiving hooks.
