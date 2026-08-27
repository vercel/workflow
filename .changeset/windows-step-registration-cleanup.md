---
'@workflow/core': patch
---

Fail the dev HMR e2e cleanup when a deleted workflow fixture is still imported by the generated step registrations, restoring the fixture so the dev server keeps serving the rest of the suite.
