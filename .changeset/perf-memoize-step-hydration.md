---
'@workflow/core': patch
'workflow': patch
---

Memoize hydrated step return values across inline replay iterations, turning the per-invocation step-result decrypt+parse cost from O(N²) to O(N) for sequential workflows. Only primitive results are cached, so deterministic replay is preserved.
