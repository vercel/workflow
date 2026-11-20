# Trigger.dev -> Workflow SDK

## Map these constructs

| Trigger.dev | Workflow SDK |
| --- | --- |
| `task({ id, run })` | `"use workflow"` or `"use step"` |
| `schemaTask({ schema, run })` | `"use workflow"` with plain typed args |
| `wait.for({ seconds \| minutes \| hours \| days })` | `sleep()` |
| `wait.until({ date })` | `sleep()` until target date |
| `wait.forToken({ timeout })` | `createHook()` or `createWebhook()` |
| `task.triggerAndWait()` | `start()` called directly in the workflow, then `await run.returnValue` |
| `task.trigger()` | `start()` from `workflow/api` |
| `batch.triggerAndWait()` / `batchTriggerAndWait()` | `Promise.all(items.map((item) => start(childWorkflow, [item])))`, then `Promise.all(runs.map((run) => run.returnValue))` |
| `tasks.trigger()` from API route / server action | `start()` from `workflow/api` |
| `idempotencyKey` / `idempotencyKeyTTL` on `trigger()` | `start(wf, args, { experimental_hook: { token, experimental_minRetention } })`; duplicates throw `HookConflictError` |
| `tags` on `trigger()` | `start(wf, args, { attributes })` (string `key=value` pairs) |
| `runs.cancel(runId)` | `getRun(runId).cancel({ cancelReason })` from app code; `run.cancel()` on a `Run` returned by `start()` in a workflow |
| `signal` (`AbortSignal`) in the task `run` context | `AbortController` in the workflow; pass its `signal` into the step |
| `AbortTaskRunError` | `FatalError` |
| `retry.onThrow` / `retry.fetch` | step `RetryableError` + `maxRetries` |
| `retry` options on `task()` | `maxRetries` on the step |
| `queue` / `machine` config on `task()` | remove from app code |
| `logger.info` / `logger.warn` | standard logging |
| `metadata.set()` (string labels used to find runs) | `setAttributes()` |
| `metadata.set()` (progress read by a UI) | `getWritable()` stream, or step return values |
| `metadata.stream()` | `getWritable()` |

## Remove

- `@trigger.dev/sdk` task registration and `client.defineJob` / `task()` wiring
- `trigger.config.ts` project config, queue config, and machine config
- `schemaTask()` Zod wrapper layer; move validation to the app boundary
- `tasks.trigger()` / `runs.retrieve()` imports inside task bodies in favor of `start()` / `getRun()`
- `wait.forToken()` token-issuance plumbing after converting to hooks/webhooks
- `AbortTaskRunError` imports after converting to `FatalError`
- `retry.onThrow` / `retry.fetch` wrappers after converting to step-level `RetryableError` + `maxRetries`
- `metadata.*` and `logger.*` runtime helpers after converting to `setAttributes()`, `getWritable()`, or standard logging

## Add

- `Promise.race()` with `sleep()` when the source used `wait.forToken({ timeout })` or `wait.for()` as a deadline
- Resume surface for `wait.forToken()` migrations:
  - Use `createHook()` + `resumeHook()` when the app resumes the workflow from server-side code with a deterministic business token.
  - Use `createWebhook()` when the external system needs a generated callback URL or the migrated flow should receive a raw `Request`, and the default `202 Accepted` response is fine.
  - Use `createWebhook({ respondWith: 'manual' })` only when the prompt explicitly requires a custom response body, status, or headers.
  - Choose exactly one surface. Do not pair `createWebhook()` with `resumeHook()`.
  - See `references/shared-patterns.md` -> `## Deterministic server-side resume`
  - See `references/shared-patterns.md` -> `## Generated callback URL (default response)`
  - See `references/shared-patterns.md` -> `## Generated callback URL (manual response)`
- Durable progress writes with `getWritable()` (replaces `metadata.stream()`)
- Idempotency keys on external writes via `getStepMetadata().stepId`
- Step-level `RetryableError` + `maxRetries` (replaces `retry.onThrow` and `retry.fetch`). Retry count lives on the step via `myStep.maxRetries = N` (default 3). Control delay between attempts by throwing `new RetryableError(msg, { retryAfter: '5s' })`. There is no built-in exponential helper; compute the delay based on `getStepMetadata().attempt` if needed.
- `FatalError` at step boundaries (replaces `AbortTaskRunError`)
- `start()` called directly in the workflow for child runs, collected with `await run.returnValue` (replaces `task.triggerAndWait()`); see `references/shared-patterns.md` -> `## Child workflow via start() in the workflow`
- Parallel fan-out via `Promise.all()` over `start()` calls, then over the returned `Run` handles' `returnValue` (replaces `batch.triggerAndWait()`)
- `start({ experimental_hook: { token } })` at the app boundary when the source passed `idempotencyKey`; map `idempotencyKeyTTL` to `experimental_minRetention`. See `references/shared-patterns.md` -> `## Idempotent start (one run per business key)`
- `setAttributes()` / `start({ attributes })` for run tags; see `references/shared-patterns.md` -> `## Run attributes (searchable metadata)`
- App-boundary `start()` from `workflow/api` in API routes / server actions (replaces `tasks.trigger()`)
- Rollback stack for compensation-heavy flows (use instead of `onFailure` when the cleanup needs to undo prior successful steps)

<!-- Verified against workflow@5.4.0 and @trigger.dev/sdk v3 on 2026-11-09 -->
