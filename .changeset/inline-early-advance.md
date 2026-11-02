---
"@workflow/core": minor
---

Let a parallel branch start its next inline step without waiting for its slower siblings (spec 8 runs on the Node.js VM). A run now ends as soon as the workflow returns or throws, even while a `Promise.race` loser is still running inline; that loser gets only its current attempt, and its step events can follow `run_completed`. Set `WORKFLOW_INLINE_EARLY_ADVANCE=0` to restore the previous behavior.
