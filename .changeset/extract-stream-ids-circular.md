---
'@workflow/core': patch
---

Fix `extractStreamIds` overflowing the stack on circular references. The hydrated observability data it walks comes from devalue, which preserves circular and repeated references, so a step result containing a cycle would crash run inspection (`wf inspect` and the web dashboard) with a `RangeError`. The traversal now tracks visited containers and skips cycles.
