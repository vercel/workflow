---
"@workflow/world-local": patch
---

Fix an edge case in `createHook({ experimental_force: true })` where a racing `resumeHook` could be dropped during the handover
