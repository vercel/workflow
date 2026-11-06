---
"@workflow/world-local": patch
---

Finish a step or wait write that a crash cut short. A process killed after a step or wait claim and before its event left the run stuck for good; the next write now takes over a claim whose writer is gone and writes the missing event. On startup, recovery also writes the missing event of a step or wait the previous process saved as finished, before the run is delivered again. After recovery, a claim left by a previous process is taken over at once, even where that process can't be checked (a container restart).
