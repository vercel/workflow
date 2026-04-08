---
'@workflow/core': patch
'@workflow/world': patch
'@workflow/world-vercel': patch
---

Fix community world E2E tests by reverting `SPEC_VERSION_CURRENT` to 2 and letting worlds declare their supported spec version via a new `specVersion` property on the World interface
