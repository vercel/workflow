---
"@workflow/core": patch
"@workflow/cli": patch
"@workflow/web": patch
"@workflow/world-testing": patch
---

Make serialization functions async

All 8 dehydrate/hydrate functions in the serialization layer are now async, returning Promises. This is a prerequisite for future encryption support where encrypt/decrypt operations are inherently asynchronous. No functional changes — the function bodies remain synchronous, only the signatures and all call sites have been updated.
