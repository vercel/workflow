---
name: migrating-workflow-v4-to-v5
description: Upgrades an app from Workflow SDK 4.x to 5.0. Use when bumping the `workflow` / `@workflow/*` dependencies to v5, or when hitting removed v4 APIs — `runStep`, `stepEntrypoint`, `workflow/internal/private`, `@workflow/core/private`, `writeToStream` / `closeStream` / `readFromStream` on a World, `world.steps.get` without a runId, `hook.getConflict()` returning `{ runId }`, `experimental_setAttributes`, `NestLocalBuilder` imported from `@workflow/nest`, or an SWC transform invoked with `mode: 'client'`.
metadata:
  author: Vercel Inc.
  version: '0.2.1'
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
6. **Whether the app calls the compiler directly.** Grep for `mode: 'client'`, `transformSync`, `swc-plugin-workflow`. Only custom build integrations do this.
7. **Whether `experimental_setAttributes` is used.** Grep for `experimental_setAttributes`.

Report anything in 2–7 that the app does not use as "not applicable" rather than silently skipping it.

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

### `experimental_setAttributes` renamed to `setAttributes`

```ts
// v4
import { experimental_setAttributes } from 'workflow';

// v5
import { setAttributes } from 'workflow';
```

The old name is a deprecated alias, so this rewrite is safe but not urgent. The `attributes` option on `start()` is unchanged.

### `mode: 'client'` removed from the SWC transform

Only relevant to a custom build integration that calls the compiler itself. The `client` mode merged into `step`, which now absorbs hoisted variable references and dead-code elimination. Pass `mode: 'step'`.

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
- **A per-run event limit is enforced.** The World supplies the ceiling (25,000 events on the Local and Vercel Worlds) and a run that reaches it fails with `MAX_EVENTS_EXCEEDED`. Flag any workflow with an unbounded loop; the fix is a child run per batch, which is a design change, not a migration edit.
- **Stream writes flush the leading chunk immediately.** The flush window default went from 10ms to 0. An app that relied on the window to coalesce a burst of tiny chunks can set `streamFlushIntervalMs` or `WORKFLOW_STREAM_FLUSH_INTERVAL_MS`.
- **Generated step, workflow and webhook bundles are ESM** (the VM-executed workflow bundle stays CJS). Only matters for a host that post-processes build output.
- **Duplicate step or workflow IDs now fail the build.** In 4.x, two identically named non-exported functions across workspace files collided last-write-wins. If the build fails on this, rename one of them — do not suppress the check.
- **`world-postgres` rows written before the upgrade.** Failed runs stored by 4.x read back with `error: undefined`, because the payload lives in the legacy `error` text column rather than `errorJson`. There is no data migration; recent-history dashboards may show blank errors for pre-upgrade failures.
- **`world-local` stream chunks moved** to `streams/chunks/<streamName>/`. Files in the old flat layout are not read back and stale files are left in place — local development state, so deleting the data directory is fine.
- **In-flight runs do not migrate, and must not.** Runs created on a 4.x deployment keep executing on that deployment. Beyond the usual skew-protection reason, deterministic seed derivation changed in v5 (`runId:workflowName:deploymentId`, clock seeded from the run ID's ULID timestamp), so replaying a pre-upgrade run on v5 produces a different sequence of correlation IDs and random values. Let 4.x runs finish where they started; do not add code to "drain" or re-target them.

## Step 4 — custom `World` implementations

Only if the app implements `World` itself. Beyond the stream and step signatures above, the interface gained:

- `streams` as a namespace (see the table in step 2).
- `analytics` — metadata-only listings for runs, steps, events, hooks, waits, and attributes.
- attribute support on runs, including `experimentalSetAttributes`.
- capability advertisement, so the runtime can gate optimizations. Unadvertised capabilities fail closed, which means an incomplete World stays correct but slower — advertise a capability only once it is genuinely implemented.
- an optional per-run event ceiling returned on run reads, which the runtime enforces.
- optional `createRunId()` and a `region` on queue options, for worlds that place run state regionally.

Two contract changes affect existing implementations:

- **Suspension and dispatch.** The asymmetric `{ timeoutSeconds }` return contract for waits is gone. Waits are ordinary queue continuations carrying `delaySeconds`, and wait plus step dispatch is unified into one parallel batch per suspension. A World that special-cased the old wait return needs rewriting against the current interface.
- **World resolution happens at build time.** Worlds are statically injected into host bundles rather than selected dynamically at runtime, and first-party World packages expose a `createWorld()` factory. A custom or community World must be resolvable by the build; verify the app still boots against it rather than assuming a runtime lookup.

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
- [ ] a compiler call still passes `mode: 'client'`
- [ ] a pre-upgrade run was replayed on the upgraded deployment
- [ ] a behavior change from step 3 was silently "fixed" instead of reported
- [ ] workflow or step bodies were restructured beyond the rules above
- [ ] generated output under `.well-known/workflow/v1/` was hand-edited
- [ ] the build, typecheck, or test results were not actually run and reported

## Reference

- What's new in v5: <https://workflow.dev/docs/whats-new>
- Configuration and runtime tuning: <https://workflow.dev/docs/configuration>
- Building a World: <https://workflow.dev/worlds/building-a-world>
- v4 documentation: <https://workflow.dev/v4/docs>
