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
| Update | `createHook()` + `resumeHook()` (one-way; no return-value parity, so stream the result via `getWritable()` or keep a separate HTTP read route) |
| Child Workflow (`executeChild` / `startChild`) | `start()` called directly in the workflow; `await run.returnValue` to collect |
| Workflow ID + `WorkflowIdReusePolicy` / `WorkflowIdConflictPolicy` | `start(wf, args, { experimental_hook: { token } })`; duplicates throw `HookConflictError`. Add `experimental_minRetention` to keep refusing after the run ends |
| Search attributes / Memo | `setAttributes()` in workflow or step; seed with `start(wf, args, { attributes })` |
| Cancellation scopes (`CancellationScope`, `isCancellation`) | `AbortController` in the workflow, `AbortSignal` passed into the step; cancel a run with `run.cancel({ cancelReason })` |
| `continueAsNew()` | `start()` the same workflow from inside the workflow with the carried state (add `deploymentId: 'latest'` on Vercel to move onto new code), then return |
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
- `start()` called directly in the workflow for child workflows (replaces `executeChild` / `startChild`). Keep the returned `Run` handle; see `references/shared-patterns.md` -> `## Child workflow via start() in the workflow`
- `start({ experimental_hook: { token } })` at the app boundary when the source relied on a fixed Workflow ID to dedupe starts; see `references/shared-patterns.md` -> `## Idempotent start (one run per business key)`
- `setAttributes()` for search attributes the app filters runs by; see `references/shared-patterns.md` -> `## Run attributes (searchable metadata)`
- `AbortSignal` passed into steps when the source cancelled in-flight Activities through a `CancellationScope`; see `references/shared-patterns.md` -> `## Cancellation`

<!-- Verified against workflow@5.4.0 and @temporalio/workflow@1.16 on 2026-11-09 -->
