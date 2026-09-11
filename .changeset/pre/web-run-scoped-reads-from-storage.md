---
'@workflow/web': patch
---

Fixes the trace and events tabs coming up empty when viewing older runs, and gaps in a run's events while it is still executing. The events tab's id search now stops after fewer pages before reporting a truncated result, and the unused `fetchSteps` server action is removed.
