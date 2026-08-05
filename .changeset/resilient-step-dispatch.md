---
'@workflow/world': minor
'@workflow/world-vercel': minor
'@workflow/core': minor
---

Resilient step dispatch: newly created steps are published to the queue in parallel with their `step_created` event write, with the serialized input carried on the message (`stepInput`) so the consumer re-ensures the event if the direct write failed transiently — mirroring resilient start (`runInput`) and resilient hook resume (`hookInput`). Under an enforced precondition guard the parallel path requires backend cooperation (`capabilities.resilientStepDispatch`, declared by world-vercel; the server revokes a 412-rejected step's in-flight dispatch), and step-dispatch idempotency keys are now step-identity-scoped. Disable via `WORKFLOW_RESILIENT_STEP_DISPATCH=0`.
