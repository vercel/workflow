---
name: migrating-workflow-v4-to-v5
description: Upgrades an app from Workflow SDK 4.x to 5.0. Use when bumping the `workflow` / `@workflow/*` dependencies to v5, or when hitting removed v4 APIs — `runStep`, `stepEntrypoint`, `workflow/internal/private`, `@workflow/core/private`, `writeToStream` / `closeStream` / `readFromStream` on a World, `world.steps.get` without a runId, `hook.getConflict()` returning `{ runId }`, or `NestLocalBuilder` imported from `@workflow/nest`.
metadata:
  author: Vercel Inc.
  version: '0.1.0'
---

# Migrating Workflow SDK 4.x to 5.0

Workflow SDK 5.0 keeps the programming model from 4.x. `"use workflow"` / `"use step"`, `start()`, `getRun()`, hooks, webhooks, streams, `sleep()`, retries, and the event log are unchanged, so most application code compiles as-is.

The breaking changes are concentrated in three places:

1. **Runtime entrypoints** (`workflow/api`, `workflow/runtime`) — two exports removed.
2. **The `World` interface** — only relevant if the app implements a custom World or calls `getWorld()` directly.
3. **Build integrations** — `@workflow/nest` subpaths, and private compiler subpaths that were never public.

Do not rewrite workflow or step bodies. If you find yourself restructuring business logic, you have gone outside this migration.

## Intake

Before editing, establish:

1. **Which packages are installed.** Read `package.json` for `workflow` and every `@workflow/*` dependency.
2. **Whether the app touches the runtime.** Grep for `getWorld`, `createWorld`, `getWorldHandlers`, `writeToStream`, `readFromStream`, `closeStream`, `listStreamsByRunId`, `getStreamChunks`, `world.steps`, `runStep`, `stepEntrypoint`, `internal/private`, `core/private`.
3. **Whether the app implements a custom World.** Grep for `implements World`, `: World`, `createLocalWorld`, `startWorkflowWorld`.
4. **Which framework integration is in use.** `@workflow/next`, `@workflow/nest`, `@workflow/nitro`, `@workflow/sveltekit`, `@workflow/vite`, `@workflow/nuxt`, `@workflow/astro`, or the CLI.
5. **Whether `hook.getConflict()` is used.** Grep for `getConflict`.

Report anything in 2–5 that the app does not use as "not applicable" rather than silently skipping it.

## Step 1 — bump the dependencies

Move every `workflow` and `@workflow/*` dependency to `^5.0.0`. They are released together and must not be mixed across majors — a 4.x `@workflow/next` against a 5.x `workflow` will fail at build time.

```json
{
  "dependencies": {
    "workflow": "^5.0.0",
    "@workflow/next": "^5.0.0"
  }
}
```

Then reinstall and rebuild so the compiler regenerates the workflow/step bundles and the generated routes under `.well-known/workflow/v1/`. Never hand-edit generated output.

Node requirements are unchanged: `^18 || ^20 || ^22 || ^24`.

## Step 2 — apply the mechanical rewrites

Apply each rule only where the pattern actually appears.

### `getWorld()` and `createWorld()` are async

```ts
// v4
const world = getWorld();

// v5
const world = await getWorld();
```

This also applies to `getWorldHandlers()`. Awaiting was already correct in 4.x, so this edit is safe to make before the dependency bump. Propagate `async` up the call chain rather than wrapping in `.then()` chains.

### `runStep` removed from `workflow/api`

Call the step function directly. The compiler routes the call through the step runtime.

```ts
// v4
import { runStep } from 'workflow/api';
const result = await runStep(chargeCard, [orderId]);

// v5
const result = await chargeCard(orderId);
```

### `stepEntrypoint` removed from `workflow/runtime`

Framework integrations generate step routes themselves — delete hand-written step routes that existed only to call `stepEntrypoint`. For a custom host, serve the handlers from `getWorldHandlers()` instead.

### `workflow/internal/private` and `@workflow/core/private` removed

These subpaths were never public API. Remove the imports; if generated build output still references them, it is stale — reinstall and rebuild rather than restoring the imports.

### Stream methods moved to `world.streams.*` with `runId` first

| v4 | v5 |
| --- | --- |
| `world.writeToStream(name, runId, chunk)` | `world.streams.write(runId, name, chunk)` |
| `world.writeToStreamMulti(name, runId, chunks)` | `world.streams.writeMulti(runId, name, chunks)` |
| `world.closeStream(name, runId)` | `world.streams.close(runId, name)` |
| `world.readFromStream(name, startIndex?)` | `world.streams.get(runId, name, startIndex?)` |
| `world.getStreamChunks(name, runId, options?)` | `world.streams.getChunks(runId, name, options?)` |
| `world.listStreamsByRunId(runId)` | `world.streams.list(runId)` |

The argument order flipped, so a rename alone silently passes a stream name where a run ID is expected. Swap the arguments at every call site. `readFromStream` had no `runId` parameter at all — `streams.get` requires one, so thread the owning run ID through to the call.

Application code that uses `getWritable()` inside a workflow or reads `run.readable` is unaffected; this rule is only for direct `World` access.

### `world.steps.get()` requires a `runId`

The first parameter was `string | undefined` and is now `string`. Pass the run ID that owns the step.

```ts
// v4
const step = await world.steps.get(undefined, stepId);

// v5
const step = await world.steps.get(runId, stepId);
```

### `hook.getConflict()` resolves with a `Run`

The resolved value is now the conflicting run handle rather than `{ runId }`. `conflict.runId` still reads the same, so existing code keeps working — but the round trip through a step to fetch the run can be deleted.

```ts
// v4
const conflict = await hook.getConflict();
if (conflict) {
  const run = await fetchRun(conflict.runId); // "use step" wrapper around getRun()
  return { dedupedTo: await run.returnValue };
}

// v5
const conflict = await hook.getConflict();
if (conflict) {
  return { dedupedTo: await conflict.returnValue };
}
```

`await conflict.status` and `await conflict.cancel()` are available on the same handle. Do not remove the `if (conflict)` null check — `getConflict()` still resolves `null` when the token was claimed cleanly.

### `NestLocalBuilder` moved out of the `@workflow/nest` root

```ts
// v4
import { NestLocalBuilder } from '@workflow/nest';

// v5
import { NestLocalBuilder } from 'workflow/nest/builder';
```

`NestVercelBuilder` lives at `workflow/nest/vercel-builder`. `WorkflowModule` still comes from `@workflow/nest`; the split keeps the build toolchain out of the runtime bundle, so do not re-export the builder from a module that runtime code imports.

## Step 3 — flag the behavior changes that need a decision

These are not code edits. Report each one that applies, and do not "fix" them silently.

- **Tracing defaults to `linked`.** Each workflow and step invocation is its own trace root with span links to the enqueue site and the run origin, instead of one trace per run. If the app has dashboards, saved queries, or alerts keyed on a single trace ID per run, either move them to the `workflow.run.id` attribute or set `WORKFLOW_TRACE_MODE=continuous` to restore the 4.x shape.
- **Event creation is guarded by default.** Replay-context writes carry a `stateUpdatedAt` snapshot and a supporting backend can reject stale writes with `PreconditionFailedError`. Backends without guard support ignore the snapshot. `WORKFLOW_PRECONDITION_GUARD=0` opts out.
- **Turbo mode is on by default.** The first invocation of a run backgrounds `run_started` and skips the initial event-log load. `WORKFLOW_TURBO=0` disables it.
- **Errors keep their type.** `WorkflowRunFailedError.cause` now preserves the original class identity and cause chain. Code that pattern-matched on `error.message` because the class was flattened in 4.x can use `instanceof` — but flag it rather than rewriting error handling unprompted.
- **`world-postgres` rows written before the upgrade.** Failed runs stored by 4.x read back with `error: undefined`, because the payload lives in the legacy `error` text column rather than `errorJson`. There is no data migration; recent-history dashboards may show blank errors for pre-upgrade failures.
- **In-flight runs do not migrate.** Runs created on a 4.x deployment keep executing on that deployment, so a deploy is not a cutover. Do not add code to "drain" or re-target them.

## Step 4 — custom `World` implementations

Only if the app implements `World` itself. Beyond the stream and step signatures above, the interface gained:

- `streams` as a namespace (see the table in step 2).
- `analytics` — metadata-only listings for runs, steps, events, hooks, waits, and attributes.
- attribute support on runs, including `experimentalSetAttributes`.
- capability advertisement, so the runtime can gate optimizations. Unadvertised capabilities fail closed, which means an incomplete World stays correct but slower — advertise a capability only once it is genuinely implemented.

Optional methods may be omitted; the runtime falls back. Point the user at the "Building a World" guide for the full interface rather than inventing method bodies.

`createLocalWorld()` from `@workflow/world-local` already took a config object in 4.x and is not a breaking change.

## Required output shape

Return the migration in this structure:

```md
## Summary
## Dependency Changes
## Code Changes
## Behavior Changes To Review
## Verification
## Open Questions
```

- `## Code Changes` lists one entry per rule applied, with the file paths touched. Rules that did not apply are listed once as not applicable — do not omit them silently.
- `## Behavior Changes To Review` carries the step 3 items that apply to this app, each with the concrete follow-up (which dashboard, which env var).
- `## Open Questions` carries anything that could not be decided from the code, especially a custom World that needs interface work.

## Verification

Run, in order, and report actual output:

1. Install and build. The build must regenerate workflow/step bundles without errors.
2. Typecheck. The async `getWorld()` change and the `steps.get` signature surface here.
3. The app's test suite.
4. Start the app and execute one real run end to end, confirming the first step runs and the run reaches a terminal state.

Fail the migration if any of these are true:

- [ ] `workflow` and `@workflow/*` versions span both 4.x and 5.x
- [ ] `getWorld()` / `createWorld()` / `getWorldHandlers()` is called without `await`
- [ ] `runStep` or `stepEntrypoint` is still imported
- [ ] `workflow/internal/private` or `@workflow/core/private` is still imported
- [ ] a `world.streams.*` call kept the v4 argument order (name before runId)
- [ ] `streams.get` was called without a `runId`
- [ ] `world.steps.get` was called with `undefined` as its first argument
- [ ] `NestLocalBuilder` is imported from `@workflow/nest` instead of `workflow/nest/builder`
- [ ] a behavior change from step 3 was silently "fixed" instead of reported
- [ ] workflow or step bodies were restructured beyond the rules above
- [ ] generated output under `.well-known/workflow/v1/` was hand-edited
- [ ] the build, typecheck, or test results were not actually run and reported

## Reference

- What's new in v5: <https://workflow.dev/docs/whats-new>
- Configuration and runtime tuning: <https://workflow.dev/docs/configuration>
- Building a World: <https://workflow.dev/worlds/building-a-world>
- v4 documentation: <https://workflow.dev/v4/docs>
