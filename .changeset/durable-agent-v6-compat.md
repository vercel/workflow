---
'@workflow/ai': patch
---

Add AI SDK v6 compatibility to DurableAgent: accept model objects (V2/V3) with auto-conversion to string IDs, normalize V3 finish reason and usage formats, pass through typed ToolResultOutput without re-wrapping, and add `instructions` alias for `system`
