---
"@workflow/ai": patch
---

`WorkflowChatTransport` now drops orphan UI chunks (deltas/ends with no matching `*-start` in the resumed window) when reconnecting with an `initialStartIndex` not matching a UI chunk boundary, instead of throwing.
