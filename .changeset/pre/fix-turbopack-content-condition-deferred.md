---
'@workflow/next': patch
---

Always apply turbopack content condition regardless of builder mode to prevent the workflow loader from running on every JS/TS file when lazy discovery is enabled.
