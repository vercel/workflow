# Temporal -> Workflow SDK

## Map these constructs

| Temporal | Workflow SDK |
| --- | --- |
| Workflow Definition / Execution | `"use workflow"` + `start()` |
| Activity | `"use step"` |
| Worker + Task Queue | remove from app code |
| Signal | `createHook()` or `createWebhook()` |
| Query / Update | `getRun()` + app API, or hook-driven mutation |
| Child Workflow | step-wrapped `start()` / `getRun()` |
| Activity retry policy (`startToCloseTimeout`, `maximumAttempts`) | `maxRetries`, `RetryableError`, `FatalError` |
| Event history | run timeline / event log |

## Remove

- `proxyActivities` and Activity type imports
- Worker setup and polling loop
- Task Queue configuration and plumbing
- Signal handler boilerplate (`defineSignal`, `setHandler`, `condition`) after converting to hooks
- Separate Activity modules when side effects move into colocated `"use step"` functions

## Add

- Resume surface when the source used Signals or approval-style pauses:
  - Use `createHook()` + `resumeHook()` when the app resumes the workflow from server-side code with a deterministic business token.
  - Use `createWebhook()` when the external system needs a generated callback URL or the migrated flow should receive a raw `Request`, and the default `202 Accepted` response is fine.
  - Use `createWebhook({ respondWith: 'manual' })` only when the prompt explicitly requires a custom response body, status, or headers.
  - Choose exactly one surface. Do not pair `createWebhook()` with `resumeHook()`.
  - See `references/shared-patterns.md` -> `## Deterministic server-side resume`
  - See `references/shared-patterns.md` -> `## Generated callback URL (default response)`
  - See `references/shared-patterns.md` -> `## Generated callback URL (manual response)`
- `Promise.race()` with `sleep()` when the source Signal had a timeout or deadline
- Idempotency keys on external writes via `getStepMetadata().stepId`
- Rollback stack for compensation-heavy flows (replaces nested try/catch around each Activity)
- `getWritable()` for progress streaming (replaces custom progress Activities)
- Step-wrapped `start()` / `getRun()` for child workflows — return serializable `runId` values to the workflow
