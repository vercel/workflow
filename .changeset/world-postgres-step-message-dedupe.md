---
"@workflow/world-postgres": patch
---

Deduplicate every run's keyed step messages with `unsafe_dedupe`: a spec 8 step message sent again while its job was being delivered added a second job, and another worker ran the step body twice.
