---
'@workflow/world': minor
'@workflow/world-vercel': minor
'@workflow/core': minor
---

Resilient step dispatch: newly created steps are published to the queue in parallel with their `step_created` event write, with the serialized input carried on the message (`stepInput`) so the consumer re-ensures the event if the direct write failed transiently — mirroring resilient start (`runInput`) and resilient hook resume (`hookInput`). Worlds that enforce the precondition guard keep the sequential create-then-publish dispatch (only sequencing gives the message a happens-after edge over the create's guard verdict); step-dispatch idempotency keys are now step-identity-scoped. Disable via `WORKFLOW_RESILIENT_STEP_DISPATCH=0`.
