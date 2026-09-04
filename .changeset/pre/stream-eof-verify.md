---
'@workflow/core': patch
---

Verify stream tail when the reconnecting framed reader receives an EOF to ensure it is due to stream completion (and not other world-side behavior)
