# Cloudflare Workflows -> Workflow SDK

## Start with the codemod

When you can run commands in the user's project, run the codemod before writing anything by hand:

```bash
npx workflow migrate cloudflare-workflows --dry-run --report cloudflare-migration.md   # preview
npx workflow migrate cloudflare-workflows --report cloudflare-migration.md             # apply
```

- It needs a clean working tree for the files it rewrites (or `--force`), and the project's `typescript` package (or `npx -p typescript -p workflow workflow migrate cloudflare-workflows`).
- It reads `tsconfig.json` for the files, and `wrangler.jsonc` / `wrangler.json` / `wrangler.toml` for `vars`, bindings, and which class each `[[workflows]]` binding runs.
- It does the mechanical part: each `class X extends WorkflowEntrypoint` becomes an exported `"use workflow"` function named `X` taking `{ payload, timestamp, instanceId, workflowName }`; each `step.do()` callback becomes a module-level `"use step"` function whose parameters are the variables it captured from `run()`; the report lists them.
- Everything it could not do safely stays in place under `// TODO(workflow-migrate): ...`. Resolve those, then replace the Worker's binding calls with the `workflowInstances()` adapter from the report (`env.MY_WORKFLOW` -> `workflowInstances('MyWorkflow', MyWorkflow)`).
- Verify each captured variable is serializable.

When you cannot run it, apply the same rules by hand with the table below. Use the adapter from `docs/content/docs/v5/comparisons/workflow-sdk-vs-cloudflare-workflows.mdx` -> `### Replace the Workflow bindings` for the app boundary.

## Map these constructs

| Cloudflare Workflows | Workflow SDK |
| --- | --- |
| `export class X extends WorkflowEntrypoint<Env, P> { async run(event, step) {...} }` | `export async function X(event: { payload: P; timestamp: Date; instanceId: string; workflowName: string }) { 'use workflow'; ... }` |
| `step.do(name, [config,] callback)` | module-level `"use step"` function; captured variables become parameters |
| `retries.limit: n` (counts retries after the first attempt) | `stepFn.maxRetries = n` |
| no `retries.limit` | `stepFn.maxRetries = 5` (Cloudflare's default; the Workflow SDK's default is 3) |
| `retries.delay` / `backoff` | not carried over; throw `RetryableError(msg, { retryAfter })` inside the step where the wait matters |
| `timeout` on `step.do` | no per-step timeout; bound the work inside the step (`AbortSignal.timeout(ms)`), and say so in `## Open Questions` |
| `ctx.attempt` / `ctx.step.name` in the callback | `getStepMetadata().attempt` (also 1-based) / the step's name |
| `step.sleep(name, '1 hour')` | `sleep('1 hour')`; months are 30 days (`'2 months'` -> `'60 days'`); a runtime duration needs Cloudflare's units table |
| `step.sleepUntil(name, date)` | `sleep(new Date(date))` |
| `step.waitForEvent(name, { type, timeout })` | read the run's events from its start Hook by type (the codemod's `workflowEvents()` helper): events sent before the wait are kept, per type in arrival order; a timeout throws `Error('WorkflowTimeoutError: Execution timed out after <ms>ms')`; default timeout 24 hours |
| `NonRetryableError` | `FatalError` |
| `this.env.VAR` (a wrangler var) | `process.env.VAR`, read inside a step |
| `this.env.KV` / D1 / R2 / Queue / AI / Durable Object bindings | a client for a service reachable from Node, used inside a step; say which in `## Open Questions` |
| `rollback` handlers on `step.do` | a rollback stack in the workflow, run in `catch`; see `references/shared-patterns.md` |
| `env.MY_WORKFLOW.create({ id, params })` | `start(X, [{ payload: params, timestamp: new Date(), instanceId: id, workflowName: 'X' }], { experimental_hook: { token: \`X:${id}\`, experimental_minRetention: '30 days' } })` |
| `instance.sendEvent({ type, payload })` | `resumeHook(\`X:${id}\`, { type, payload, timestamp: new Date() })` |
| `env.MY_WORKFLOW.get(id)` / `instance.status()` | `getHookByToken(\`X:${id}\`)` -> `getRun(hook.runId)` -> `status`, `returnValue` |
| `instance.terminate()` | `run.cancel()` |
| `pause()` / `resume()` / `restart()` | no equivalent: cancel and start a new run |

## Watch for

- **The start token carries the events.** `workflowEvents()` reads the hook on the run's start token, so the run must be started with `experimental_hook: { token: \`X:${id}\` }`; otherwise events sent before the first wait are lost.
- **Errors after retries run out.** In the workflow, a step that exhausts its retries rejects with a `FatalError` (`Step "..." failed after N retries: <message>`) whose `cause` is the step's error; Cloudflare's `step.do()` rejected with the step's error itself.
- **Status names.** Workflow SDK runs are `pending`/`running`/`completed`/`failed`/`cancelled`; map them to Cloudflare's `queued`/`running`/`complete`/`errored`/`terminated`. There is no `waiting` or `paused`.
- **`this` in step callbacks.** Anything other than `this.env.VAR` (class members, `this.ctx`) has no equivalent.
- **Code outside steps runs in a sandbox.** No I/O and no environment variables outside steps.

## Add

- Resume surface for each `step.waitForEvent()`: the sender's `instance.sendEvent()` becomes `resumeHook()` on the instance's start token (see the mapping above), not a separate `createHook()` per wait.
- Idempotency keys on external writes via `getStepMetadata().stepId`.
- A rollback stack where `step.do()` had rollback handlers.

<!-- Verified against workflow@5, wrangler 4.163.0 and @cloudflare/workers-types 5.20261116.1 on 2026-11-16 -->
