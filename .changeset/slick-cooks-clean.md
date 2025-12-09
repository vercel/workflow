---
"@workflow/core": patch
---

perf: use Map for invocationsQueue (O(1) lookup/delete)

Replace array-based invocationsQueue with Map for O(1) lookup and delete operations, eliminating O(n²) complexity in high-concurrency workflows.
