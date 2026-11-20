---
'@workflow/core': patch
---

Spec 9 run-ahead counts an open wait as due only if it comes due within `WORKFLOW_OPEN_WAIT_CLOCK_SKEW_MS` of now, not anywhere in the inline window, so a wait minutes away no longer stops run-ahead (proof of concept).
