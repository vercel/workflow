---
'@workflow/core': patch
'@workflow/world': patch
---

Fix cross-deployment hook resumes and starts writing zstd payloads to runs on Node.js versions that cannot decode them.
