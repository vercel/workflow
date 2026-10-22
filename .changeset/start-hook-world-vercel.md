---
'@workflow/world-vercel': minor
---

Send `startHook` on run creation and map start Hook answers, including `425 hook-reserved` (older SDKs see it as `TooEarlyError`, not `HookNotFoundError`); `atomicStartHook` is advertised only with `WORKFLOW_VERCEL_EXPERIMENTAL_START_HOOK=1`.
