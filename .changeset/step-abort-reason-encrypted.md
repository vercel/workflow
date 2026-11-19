---
"@workflow/core": patch
---

Keep the abort reason when a workflow aborts a signal a running step holds on an encrypted run, instead of aborting the step's signal with a generic `AbortError`.
