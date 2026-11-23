---
'@workflow/core': patch
---

Spec 9 run-ahead counts an open wait as due only if it comes due within `WORKFLOW_OPEN_WAIT_CLOCK_SKEW_MS` of now, not anywhere in the inline window, so a wait minutes away no longer stops run-ahead (proof of concept).

The allowance is at least 1 s whatever the setting, and the window still ends no later than the inline deadline plus the allowance, where it used to end. Spec 8 is unchanged.
