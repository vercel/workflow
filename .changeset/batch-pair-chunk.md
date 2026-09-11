---
"@workflow/core": patch
---

Commit the batched fan-out's pre-claimed inline `[step_created, step_started]` pairs in their own leading chunk, ahead of the plain step/wait creates, so the write that gates the inline bodies stays small and commits faster.
