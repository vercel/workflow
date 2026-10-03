---
"@workflow/core": patch
"@workflow/world-vercel": patch
---

Retry identical step-result delivery with bounded backoff and recover uncertain remote dispatches without failing the run. Batch up to 100 contiguous eligible completion inputs behind one durability barrier before advancing the retained workflow or acknowledging callers.
