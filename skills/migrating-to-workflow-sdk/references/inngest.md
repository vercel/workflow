# Inngest -> Workflow SDK

## Start with the codemod

When you can run commands in the user's project, run the codemod before writing anything by hand:

```bash
npx workflow migrate inngest --dry-run --report inngest-migration.md   # preview
npx workflow migrate inngest --report inngest-migration.md             # apply
```

- It needs a clean working tree for the files it rewrites (or `--force`), and the project's `typescript` package (or `npx -p typescript -p workflow workflow migrate inngest`).
- Without paths it migrates the files of the project's `tsconfig.json`; pass paths to limit it.
- It does the mechanical part: every `createFunction()` becomes an exported `"use workflow"` function taking the trigger event, and every `step.run()` closure becomes a module-level `"use step"` function. Each variable the closure captured from the handler (the event, earlier step results, loop variables) becomes a parameter and is passed at the call site. The report lists the captured variables of every step.
- Everything it could not do safely is left in place under a `// TODO(workflow-migrate): ...` comment. Your job is to resolve those, then replace the app-boundary calls the report lists (`inngest.send()` -> `start()` or `resumeHook()`, delete the `serve()` route).
- Verify each captured variable listed in the report is serializable (plain data, `Date`, `Map`, `Set`, `URL`, typed arrays, `Request`/`Response`, `AbortSignal`, workflow functions, or classes with custom serialization). Functions and plain class instances are not.

When you cannot run it (the prompt only contains code), apply the same rules by hand, using the table below.

## Map these constructs

| Inngest | Workflow SDK |
| --- | --- |
| `inngest.createFunction(config, trigger, handler)` / `createFunction({ triggers }, handler)` | exported `"use workflow"` function taking the event: `export async function name(event) { 'use workflow'; ... }`, started with `start(name, [event])` |
| `step.run(id, closure, ...inputs)` | module-level `"use step"` function; captured variables become parameters (before the `inputs`) |
| `step.sleep(id, duration)` / `step.sleepUntil(id, date)` | `sleep(duration)` / `sleep(new Date(date))` |
| `step.waitForEvent(id, { event, timeout, match: 'data.x' })` | `Promise.race([createHook({ token: \`${event}:${triggerEvent.data.x}\` }), sleep(timeout).then(() => null)])`; the sender calls `resumeHook(\`${event}:${sent.data.x}\`, sent)` |
| `step.waitForEvent` with `if: 'async.data.a == event.data.b'` or `` if: `async.data.a == "${v}"` `` | same, token built from `event.data.b` or `v` |
| `step.waitForEvent` with another `if`, or no `match` | pick a deterministic business token yourself; see `references/resume-routing.md` |
| `step.waitForSignal(id, { signal, timeout, onConflict })` | `createHook({ token: signal })` (plus `experimental_force: true` for `onConflict: 'replace'`) raced against `sleep()`; `inngest.sendSignal({ signal, data })` -> `resumeHook(signal, { signal, data })` |
| `step.invoke(id, { function, data })` | `start(childWorkflow, [{ data }])` called directly in the workflow, then `await run.returnValue` |
| `inngest.send()` / event triggers | app-boundary `start(workflow, [event])` |
| `step.sendEvent()` | `start()` called directly in the workflow per target workflow; `resumeHook()` inside a `"use step"` function for a waiting run |
| `step.fetch(url, init)` | `fetch` imported from `workflow` (it is a step) |
| `step.ai.wrap(id, fn, ...inputs)` | `"use step"` function that evaluates the inputs and calls `fn` itself (the model object must not be a step argument); return only the fields you use |
| `step.ai.infer()` | call the model from a `"use step"` function, or use `WorkflowAgent` |
| `step.realtime.publish()` / `inngest.realtime.publish()` | `getWritable()` in the workflow; write inside a `"use step"` function |
| `retries: n` | `stepFn.maxRetries = n` on each step |
| `NonRetriableError(msg)` / `RetryAfterError(msg, after)` | `FatalError(msg)` / `RetryableError(msg, { retryAfter: after })` |
| `idempotency: 'event.data.id'` / `singleton` | `start(wf, [event], { experimental_hook: { token, experimental_minRetention: '24h' } })`; see `references/shared-patterns.md` -> `## Idempotent start (one run per business key)` |
| `cancelOn` | `getRun(runId).cancel()` where the cancel event was sent, or an `AbortController` whose signal is passed into steps; see `references/shared-patterns.md` -> `## Cancellation` |
| `runId` / `attempt` / `logger` | `getWorkflowMetadata().workflowRunId` / `getStepMetadata().attempt - 1` (Workflow counts from 1) / `console` |
| `onFailure` | `try`/`catch` around the workflow body, a cleanup step in `catch`, then rethrow |
| concurrency, throttle, rateLimit, debounce, batchEvents, priority | no function-level equivalent; enforce at the caller of `start()` or inside steps, and say so in `## Open Questions` |
| cron trigger | a scheduled job (Vercel Cron, system cron) calling `start()` |

## Remove

- Inngest client setup (`new Inngest(...)`) once nothing imports it
- `serve()` handler and function registration (the framework integration serves the workflow routes)
- Event-schema dispatch layer and event type definitions used only for routing
- Inline `step.run()` closures after extracting them into named `"use step"` functions
- `step.waitForEvent()` match expressions; hook tokens replace event matching

## Watch for

- **Writes to captured variables.** `step.run('x', () => { count++ })` cannot be lifted as is: the step gets a copy. Return the new value and assign it in the workflow.
- **Captured local functions.** A closure that calls a helper declared inside the handler needs the helper moved to module scope first.
- **I/O outside steps.** Inngest re-ran handler code outside `step.run()` on every request; a workflow function cannot do I/O at all. Move `fetch()`, database and SDK calls into steps.
- **Result types.** Inngest JSON-serialized step results (`Date` became a string, `undefined` became `null`); the Workflow SDK keeps the types.
- **Event fields.** The workflow receives what `start()` passes. Code reading `event.id` or `event.ts` needs the caller to pass them, or `getWorkflowMetadata()`.

## Add

- `Promise.race()` with `sleep()` when the source used timeout-based waits on `step.waitForEvent()`
- Resume surface for `step.waitForEvent()` migrations:
  - Use `createHook()` + `resumeHook()` when the app resumes the workflow from server-side code with a deterministic business token (the usual case: the token comes from `match`).
  - Use `createWebhook()` when the external system needs a generated callback URL or the migrated flow should receive a raw `Request`, and the default `202 Accepted` response is fine.
  - Use `createWebhook({ respondWith: 'manual' })` only when the prompt explicitly requires a custom response body, status, or headers.
  - Choose exactly one surface. Do not pair `createWebhook()` with `resumeHook()`.
  - See `references/shared-patterns.md` -> `## Deterministic server-side resume`
  - See `references/shared-patterns.md` -> `## Generated callback URL (default response)`
  - See `references/shared-patterns.md` -> `## Generated callback URL (manual response)`
- Durable progress writes with `getWritable()` (replaces `step.realtime.publish()`)
- Idempotency keys on external writes via `getStepMetadata().stepId`
- Rollback stack for compensation-heavy flows (replaces per-step try/catch compensation)
- `start()` called directly in the workflow for child runs, with `await run.returnValue` (replaces `step.invoke()`); see `references/shared-patterns.md` -> `## Child workflow via start() in the workflow`

<!-- Verified against workflow@5.4.0 and the Inngest TypeScript SDK v4.26 on 2026-11-09 -->
