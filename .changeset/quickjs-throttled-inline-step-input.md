---
'@workflow/core': patch
---

QuickJS VM: give the step input to the retry message of a throttled lazy inline step, so the consumer can create the step instead of failing with "step not found" until the delivery ceiling.
