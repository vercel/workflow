---
'@workflow/world': patch
'workflow': patch
---

Carry step input, attempt number, and log position on step dispatch messages so queued steps hydrate their input and stop retrying past maxRetries on Worlds without step rows
