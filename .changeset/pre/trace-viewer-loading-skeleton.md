---
'@workflow/web-shared': patch
'@workflow/web': patch
---

Add a loading skeleton to the new trace viewer that matches the real layout's dimensions, and start with the detail panel closed instead of pre-selecting the first span. The skeleton is also exported as `TraceViewerSkeleton` for consumers that need to render it standalone.
