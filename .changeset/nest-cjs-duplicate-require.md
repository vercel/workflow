---
"@workflow/nest": patch
---

Fix the CommonJS steps bundle declaring `require` twice, which made it throw on import.
