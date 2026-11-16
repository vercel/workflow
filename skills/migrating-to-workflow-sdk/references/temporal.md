# Temporal -> Workflow SDK

## Start with the codemod

When you can run commands in the user's project, run the codemod before writing anything by hand:

```bash
npx workflow migrate temporal --dry-run --report temporal-migration.md   # preview
npx workflow migrate temporal --report temporal-migration.md             # apply
```

- It needs a clean working tree for the files it rewrites (or `--force`), and the project's `typescript` package (or `npx -p typescript -p workflow workflow migrate temporal`). Without paths it migrates the files of the project's `tsconfig.json`, plus the activities modules the workflows proxy.
- It adds `"use workflow"` to every exported function of a module that imports `@temporalio/workflow`; replaces each `proxyActivities<typeof activities>()` with a plain import of the activities; and adds `"use step"` to each activity in its own module, with `retry.maximumAttempts: n` as `maxRetries = n - 1`.
- Signals become hooks with the token `` `${runId}:<signal name>` ``, created when the run starts (so a signal sent before `setHandler()` waits, as Temporal buffers it). A small `TemporalSignals` helper appended to the file runs the original handler for each payload in order and re-checks `condition()` after each one. The payload is the signal's arguments array.
- It also maps `sleep`, `executeChild`/`startChild`/`handle.result()` (to `start()` in the workflow and `run.returnValue`), `workflowInfo()` (to `getWorkflowMetadata()`), `uuid4()` (to `crypto.randomUUID()`), `patched()` (to the new branch), `deprecatePatch()` (removed), `log` (to `console`), `ApplicationFailure` (to `FatalError` / `RetryableError` / `Error`), and the activity's `Context.current().info.attempt` (to `getStepMetadata().attempt`, both 1-based).
- Everything else is left in place under a `// TODO(workflow-migrate): ...` comment: queries, updates, `continueAsNew`, cancellation scopes, `workflowInfo().workflowId`, a `condition()` no signal changes, and an activity with no `maximumAttempts`. Your job is to resolve those and replace the client calls the report lists (its Signal routing table gives each signal's token).

When you cannot run it (the prompt only contains code), apply the same rules by hand, using the table below.

## Imports

Userland imports come from `workflow` and `workflow/api`. Never import from `@workflow/core`, `@workflow/next`, `@workflow/cli`.

## Map these constructs

| Temporal | Workflow SDK |
| --- | --- |
| Workflow Definition / Execution | `"use workflow"` + `start()` |
| Activity | `"use step"` |
| Worker + Task Queue | remove from app code |
| Signal (`defineSignal` + `setHandler`) | a hook per signal created at the top of the run (token `` `${runId}:${name}` ``), with the handler run for each payload; new code: one `createHook()` + `await` with a deterministic business token |
| `condition(fn, timeout)` | wait until `fn()` holds, re-checked after each signal, raced against `sleep(timeout)`; returns `false` on timeout |
| `handle.signal(sig, ...args)` | `resumeHook(`${runId}:${sig.name}`, args)`; `runId` from `start()` or `(await getHookByToken(workflowId)).runId`; retry briefly on `HookNotFoundError` right after `start()` |
| `patched()` / `deprecatePatch()` | not needed: runs are pinned to the deployment that started them, so new code always takes the new branch |
| `workflowInfo()` | `getWorkflowMetadata()`: `runId` -> `workflowRunId`, `startTime` -> `workflowStartedAt`, `workflowType` -> the function name at the end of `workflowName`; `workflowId` has no equivalent (it is the caller's start token) |
| `uuid4()` | `crypto.randomUUID()` (seeded per run, replay-safe) |
| `ApplicationFailure.nonRetryable()` / `.create({ nextRetryDelay })` / `.retryable()` | `FatalError` / `RetryableError(msg, { retryAfter })` / `Error` |
| `Context.current().info.attempt` | `getStepMetadata().attempt` (both start at 1); `heartbeat()` has no equivalent and is removed |
| Query | `getWritable({ namespace: 'status' })` on the workflow side; clients read via `getRun(runId).getReadable()` |
| Update | `createHook()` + `resumeHook()` (one-way; no return-value parity, so stream the result via `getWritable()` or keep a separate HTTP read route) |
| Child Workflow (`executeChild` / `startChild`) | `start()` called directly in the workflow; `await run.returnValue` to collect |
| Workflow ID + `WorkflowIdReusePolicy` / `WorkflowIdConflictPolicy` | `start(wf, args, { experimental_hook: { token } })`; duplicates throw `HookConflictError`. Add `experimental_minRetention` to keep refusing after the run ends |
| Search attributes | `setAttributes()` in workflow or step; seed with `start(wf, args, { attributes })`. Values are plaintext strings (up to 256 bytes, 64 per run): convert numbers, dates and keywords to strings |
| Memo | not attributes: Memo holds arbitrary, non-indexed data. Pass it as a workflow argument, keep it in the run's return value or a `getWritable()` status stream, or store it in your database. Promote only small string labels you filter by to `setAttributes()` |
| Cancellation scopes (`CancellationScope`, `isCancellation`) | `AbortController` in the workflow, `AbortSignal` passed into the step; cancel a run with `run.cancel({ cancelReason })` |
| `continueAsNew()` | not needed: Temporal restarts runs because history and payloads are capped. Keep the run going (continue the loop with the new state) and start runs with `WORKFLOW_VM=quickjs`, where snapshotting exempts a run from the default event limit and keeps resumes fast; remove `workflowInfo().continueAsNewSuggested` / `historyLength` checks. Start a new run only to move onto newer code: `start(thisWorkflow, [state], { deploymentId: 'latest' })`, then return. Steps per run are still capped: bundle items or use child workflows for very long chains |
| Temporal Schedules (`client.schedule.create()`, cron workflows) | a [Vercel Schedule](https://vercel.com/docs/schedules/workflows) targeting a queue topic whose consumer calls `start()` with ``experimental_hook: { token: `${name}:${message.executionId}`, experimental_minRetention: '7 days' }`` and returns on `HookConflictError`; static schedules in `vercel.json`, dynamic ones (per user, created at runtime) with `@vercel/schedules`; schedules take an IANA `timezone`. Overlap and backfill policies have no equivalent |
| Activity timeouts (`startToCloseTimeout`, `scheduleToCloseTimeout`, `heartbeatTimeout`) | enforce inside steps with `AbortSignal.timeout()`, or `Promise.race(step(), sleep(...))` from the workflow |
| Activity retry policy (`maximumAttempts`, `initialInterval`, etc.) | `maxRetries = maximumAttempts - 1`; Temporal's default is unlimited, the Workflow SDK's is 3 retries, so set `maxRetries` explicitly when the source set no `maximumAttempts`; `RetryableError` / `FatalError` classification |
| Event history | run timeline / event log |

## Watch for

- **A plain `Error` thrown in workflow code fails the run.** Temporal failed only the workflow task (and retried it) unless the error was an `ApplicationFailure`.
- **`condition()` on non-signal state.** The migrated `condition()` re-checks after each signal only. A predicate that another branch of the workflow (a step result, a `Promise.all` branch) makes true needs its own hook or a direct `await`.
- **Unwrapped failures.** Catch blocks that test `instanceof ActivityFailure` / `ChildWorkflowFailure` now see the step's own error, or `WorkflowRunFailedError` with the child's error as `cause`.
- **Activity arguments and results are serialized** with the Workflow SDK serializer: `Date`, `Map`, `Set` survive; class instances need custom serialization.
- **Cut over by draining.** Runs started on Temporal finish on Temporal: keep the workers until they drain, and signal both paths meanwhile.

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

<!-- Verified against workflow@5.4.0, @temporalio/*@1.25.0 and the Temporal CLI 1.10.1 dev server on 2026-11-16 -->
