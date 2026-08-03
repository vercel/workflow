---
'@workflow/ai': patch
---

DurableAgent now recovers from invalid tool-call input by returning the validation error to the model instead of aborting the stream.
