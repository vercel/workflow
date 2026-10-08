---
'@workflow/cli': minor
---

`workflow inspect runs -n` and `workflow inspect attributes -n` accept the short workflow name the runs table shows (`processOrder`), resolving it to the full name among recent runs. A full name is sent as before, with no extra request.
