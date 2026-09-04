---
'@workflow/core': patch
'@workflow/world': patch
'@workflow/world-vercel': patch
'@workflow/world-local': patch
'@workflow/world-postgres': patch
---

Fix community world E2E tests by adding `specVersion` to the World interface so `start()` uses the safe baseline (v2) for worlds that don't declare their supported version
