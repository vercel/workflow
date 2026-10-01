---
"@workflow/core": patch
---

Dynamic `start()` validation: cap `exportName` at 64 characters, detect `"use step"` only as a real directive, and name non-async, generator, and duplicate workflow declarations.
