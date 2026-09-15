---
'@workflow/core': minor
'workflow': minor
---

Retained workflow VMs now keep the fast path when step arguments are plain data or standard built-ins (`Map`, `Set`, `Date`, typed arrays, `URL`, `Headers`, …), not just primitives. A boundary falls back to a normal replay only when serializing its arguments ran code the workflow controls — a getter, a proxy, a custom serializer — or computed an `Error`'s stack trace.
