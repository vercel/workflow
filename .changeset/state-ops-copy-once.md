---
"@workflow/core": patch
---
Rebuild state passed between steps by reference with one copy per changed container per step result, and plain assignment instead of `Object.defineProperty`, so replaying a long run spends far less time rehydrating step results.
