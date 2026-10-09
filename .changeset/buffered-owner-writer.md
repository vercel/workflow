---
'@workflow/core': patch
'@workflow/world': patch
---

Support explicit buffered event-writer sessions in the retained owner. Stage ordered transitions in the private working state, and flush the durable prefix before input acknowledgement or user-step execution. Existing unbuffered writers retain their current behavior.
