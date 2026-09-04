---
"@workflow/web-shared": patch
---

New trace viewer cleanup: fix `EventRow` crash on spans without `attributes.data`, drop dead `DetailPanel` + empty placeholder files, give time markers and segments stable keys, fix invalid `stroke-linejoin` JSX attribute, and replace the unsafe `Trace` cast with the real `TraceWithMeta` type.
