---
'@workflow/core': patch
'@workflow/world': patch
---

Make `resumeHook()` durable before it resolves. New consumers fence payload-less
workflow wakes until the producer's matching `hook_received` event is visible;
older consumers keep the sequential write-then-publish path. Remove the internal
`resumeHookDurable()` alias now that `resumeHook()` provides the same guarantee.
