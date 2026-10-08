---
'@workflow/cli': patch
---

`workflow inspect stream` exits non-zero when it cannot read or decode the stream, instead of printing the error and exiting 0.
