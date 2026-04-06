# Inngest -> Workflow SDK

## Map these constructs

| Inngest | Workflow SDK |
| --- | --- |
| `inngest.createFunction()` | `"use workflow"` + `start()` |
| `step.run()` | `"use step"` |
| `step.sleep()` / `step.sleepUntil()` | `sleep()` |
| `step.waitForEvent()` | `createHook()` or `createWebhook()` |
| timeout on `step.waitForEvent()` | `Promise.race()` + `sleep()` |
| `step.invoke()` | step-wrapped `start()` / `getRun()` |
| `inngest.send()` / event triggers | app-boundary `start()` |
| `step.sendEvent()` | step-wrapped `start()` fan-out |
| `step.realtime.publish()` | `getWritable()` |

## Remove

- Inngest client setup (`new Inngest(...)`)
- `serve()` handler and function registration
- Event-schema dispatch layer and event type definitions used only for routing
- Inline `step.run()` closures after extracting them into named `"use step"` functions
- `step.waitForEvent()` match expressions — hook tokens replace event matching

## Add

- `Promise.race()` with `sleep()` when the source used timeout-based waits on `step.waitForEvent()`
- Resume surface for `step.waitForEvent()` migrations:
  - Use `createHook()` + `resumeHook()` when the app resumes the workflow from server-side code with a deterministic business token.
  - Use `createWebhook()` when the external system needs a generated callback URL or the migrated flow should receive a raw `Request`, and the default `202 Accepted` response is fine.
  - Use `createWebhook({ respondWith: 'manual' })` only when the prompt explicitly requires a custom response body, status, or headers.
  - Choose exactly one surface. Do not pair `createWebhook()` with `resumeHook()`.
  - See `references/shared-patterns.md` -> `## Deterministic server-side resume`
  - See `references/shared-patterns.md` -> `## Generated callback URL (default response)`
  - See `references/shared-patterns.md` -> `## Generated callback URL (manual response)`
- Durable progress writes with `getWritable()` (replaces `step.realtime.publish()`)
- Idempotency keys on external writes via `getStepMetadata().stepId`
- Rollback stack for compensation-heavy flows (replaces per-step try/catch compensation)
- Step-wrapped `start()` / `getRun()` for child workflows (replaces `step.invoke()`)
