# Temporal -> Workflow SDK

## Imports

Userland imports come from `workflow` and `workflow/api`. Never import from `@workflow/core`, `@workflow/next`, `@workflow/cli`.

## Map these constructs

| Temporal | Workflow SDK |
| --- | --- |
| Workflow Definition / Execution | `"use workflow"` + `start()` |
| Activity | `"use step"` |
| Worker + Task Queue | remove from app code |
| Signal | `createHook()` or `createWebhook()` |
| Query | `getWritable({ namespace: 'status' })` on the workflow side; clients read via `getRun(runId).getReadable()` |
| Update | `createHook()` + `resumeHook()` (one-way; no return-value parity — stream the result via `getWritable()` or keep a separate HTTP read route) |
| Child Workflow | step-wrapped `start()` / `getRun()` |
| Activity timeouts (`startToCloseTimeout`, `scheduleToCloseTimeout`, `heartbeatTimeout`) | enforce inside steps with `AbortSignal.timeout()`, or `Promise.race(step(), sleep(...))` from the workflow |
| Activity retry policy (`maximumAttempts`, `initialInterval`, etc.) | `maxRetries` + `RetryableError` / `FatalError` classification |
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

<!-- Verified against workflow@5.0.0-beta.1 and @temporalio/workflow@1.16 on 2026-04-16 -->
