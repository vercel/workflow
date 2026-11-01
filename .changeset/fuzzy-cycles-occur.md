---
"@workflow/world-local": patch
---

Take over a run's in-band fence lock at once when its holder is known to be dead (its pid is gone on this host), instead of stalling in-band writes on that run for 30 s after the holder was killed
