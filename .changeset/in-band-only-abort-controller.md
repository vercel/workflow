---
'@workflow/core': patch
---

Add `new AbortController({ inBandOnly: true })` for controllers that only workflow code aborts, so an open one doesn't stop run-ahead.
