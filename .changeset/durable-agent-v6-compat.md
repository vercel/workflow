---
'@workflow/ai': patch
---

Add AI SDK v6 compatibility to DurableAgent: accept model objects (V2/V3) with auto-conversion to string IDs, normalize V3 finish reason and usage formats, and pass through typed ToolResultOutput without re-wrapping
