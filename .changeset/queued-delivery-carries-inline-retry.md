---
"@workflow/core": patch
---

Fix a run stalling after a failed inline step attempt when a queued delivery of the same step was waiting on it in the same process: the inline retry was folded into that delivery's message, which then acked as skipped. The waiting delivery now carries the retry.
