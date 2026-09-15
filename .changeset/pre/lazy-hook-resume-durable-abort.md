---
'@workflow/core': patch
---

Keep the eager `hook_received` write for the internal resume that records a step-issued abort, so it stays committed before the step completes.
