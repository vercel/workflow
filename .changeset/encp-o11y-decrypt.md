---
'@workflow/core': minor
'@workflow/web-shared': patch
'@workflow/cli': patch
---

Let observability tooling decrypt sealed (`encp`) payloads: key resolution now yields the run's full key capability, and `hydrateDataWithKey` dispatches on the envelope format.
