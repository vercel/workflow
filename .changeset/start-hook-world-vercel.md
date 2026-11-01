---
'@workflow/world-vercel': minor
---

Send `startHook` on run creation and map start Hook answers, retrying a delivery to a start Hook whose run is still being created, honoring `Retry-After`; `atomicStartHook` is advertised only with `WORKFLOW_VERCEL_EXPERIMENTAL_START_HOOK=1`, which needs a backend that supports start Hooks.
