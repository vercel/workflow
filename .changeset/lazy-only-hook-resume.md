---
'@workflow/core': patch
---

`resumeHook()` no longer writes the `hook_received` event itself on the lazy path: the queue consumer creates it from the queue message, so a resume costs one round trip. A resume against an already-ended run now resolves instead of throwing `HookNotFoundError`.
