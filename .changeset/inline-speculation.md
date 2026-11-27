---
"@workflow/core": patch
---

While the queue answers a held orchestrator send, `start()` and `resumeHook()` prepare the inline delivery (load the run's orchestrator, compile the workflow bundle or the QuickJS baseline, build the World) instead of waiting for the answer. The preparation writes nothing and starts no step, so a `not_held` answer simply drops it; `WORKFLOW_INLINE_SPECULATION=0` turns it off. `workflow.start` and `workflow.inline.consume` spans now carry phase timings for the time to the first step.
