---
"@workflow/ai": patch
---

Fix `WorkflowChatTransport` blocking browser paint during stream reconnect by yielding to the macrotask queue between chunks
