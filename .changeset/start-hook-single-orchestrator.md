---
'@workflow/core': patch
---

The single-orchestrator engine admits `start({ hook })` candidates: their first delivery skips turbo, `run_started` carries the start Hook request and public key, a refused candidate acknowledges without running code, and the workflow's `createHook({ token })` binds to the start Hook on both engines.
