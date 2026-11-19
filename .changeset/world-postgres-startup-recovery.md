---
'@workflow/world-postgres': patch
---

Skip runs parked on a hook or a future wait in startup recovery, and stop restarts from stacking duplicate recovery jobs; run `bootstrap` before upgrading (migration 0032).
