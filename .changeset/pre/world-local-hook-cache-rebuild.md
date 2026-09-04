---
'@workflow/world-local': patch
'@workflow/world': patch
---

Keep local hooks reachable after a crash or restart by rebuilding lost hook cache files from committed hook creation events, preventing active hook tokens from being reused.
