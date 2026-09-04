---
'@workflow/core': patch
---

Stop reporting replay divergence for an event the workflow is still on its way to consuming, by waiting for in-flight step and hook deliveries instead of a fixed delay
