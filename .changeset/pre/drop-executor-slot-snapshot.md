---
'@workflow/core': patch
'@workflow/world': patch
---

Stop sending a slot snapshot (`eventCount`) on step executor writes, so a World no longer reads and returns a skipped-slot event page that the executor only discards.
