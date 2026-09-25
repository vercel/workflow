---
'@workflow/core': patch
---

QuickJS VM: defer a replay after a throttled lazy inline step's backoff, like the node engine, instead of queueing the never-created step as a background step that fails "step not found" until the delivery ceiling.
