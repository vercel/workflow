---
"@workflow/world-local": patch
---

Hold the victim's per-hook lock while `createHook({ experimental_force: true })` takes a token over, so a concurrent `resumeHook()` to the victim is either journaled before its `hook_disposed` or redirected to the new owner. Previously the resume could land after the disposal and its payload was silently lost.
