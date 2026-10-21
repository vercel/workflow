---
"@workflow/core": patch
---

Keep the QuickJS VM heap flat over long runs: settled steps, sleeps, attributes and disposed hooks are released instead of retained (with their step arguments) for the rest of the run, and event replay no longer scans every operation the run ever created.
