# @workflow/world

Core interfaces and types for Workflow SDK storage backends.

This package defines the `World` interface that abstracts workflow storage, queuing, authentication, and streaming operations. Implementation packages like `@workflow/world-local` and `@workflow/world-vercel` provide concrete implementations.

Used internally by `@workflow/core` and world implementations. Should not be used directly in application code.

## Optional invocation delivery

`world.invoke(runId, payload, options?)` sends an input to a workflow runner and
returns its response. Invoke returns after the runner has processed the payload
and may fail if the runner rejects it. The World must route the payload to the
active runner, or start or resume the runner if none is active.

Invocation support is optional. A World that implements `invoke` and enables
`WorldCapabilities.invoke` must guarantee **at most one active workflow runner
per `runId`, across all worker processes**. Different runs may execute
concurrently. A replacement runner may take over after the previous runner stops,
so a run can use different processes over its lifetime.

A World that implements `invoke` calls the existing `createQueueHandler` callback
with `{ runId, invoke: true, requestId, input }`. The runner validates the input,
waits for required event writes, and returns a value. The World delivers that
value to the caller. The callback must be able to process inputs while the run
awaits step work, without starting a second runner for that run. Worlds without
invocation support must leave the capability unset.

`InvokeOptions` accepts an `idempotencyKey` for retries and a `timeoutMs`
response-wait limit. In invocation mode, the callback's return value is response
data, including any `timeoutSeconds` property. Ordinary workflow wake results
use `timeoutSeconds` to schedule another execution.

World transports can use `InvocationOutcome` to carry returned values or
serialized handler errors. The `@workflow/errors/invocation` helpers restore
known Workflow error classes for the caller. A transport failure leaves the
processing outcome unknown. A handler error can occur after event writes have
committed.

## Owner event sessions

`events.createWriteSession(runId)` optionally supplies a run-scoped writer with
canonical bootstrap readers and a flush-through durability barrier. Its optional
`heads` exposes writer-local `queued` and `committed` positions. Queued progress
may advance private execution state; only committed progress authorizes input
acknowledgement or user-step execution. The session does not acquire ownership.

## Step dispatch context

`WorkflowInvokePayload.runContext` carries the run's deployment ID, spec version,
start time, and lineage root. Consumers use this identity to start queued steps
without first fetching the run. Run status is not carried on the message: World
implementations must reject `step_started` on terminal runs, including redelivery
for a step that still has `running` status. In-flight steps may still record
`step_completed` or `step_failed` after the run ends.

## Implementation constraint: no mutable module state

A World implementation must not keep mutable state at module scope. Hold it on
the World instance, or, when it is genuinely process-wide (an ID generator
whose sequence must not fork, a log-once latch), on `globalThis` via
`globalSingleton()` from `@workflow/utils`.

`@workflow/world-local` and `@workflow/world-vercel` are bundled into the host
application's server build, and a bundler keys module identity on
`(resource, layer)`: Next.js alone compiles `instrument`, app-route, `ssr` and
`edge` as separate module graphs, so one process holds one copy of every module
in these packages *per layer*. A top-level `let`, or a `const` holding a `Map`,
is therefore per-copy state rather than the singleton it reads as.

A world loaded at runtime through `WORKFLOW_TARGET_WORLD` is deduped by Node's
module cache and does not have this problem today, but that is a property of
how it is loaded, not of how it is written, and it has changed before
(vercel/workflow#3493). `scripts/lint/module-scope-state.mjs` enforces the rule
across every published world package; see
`docs/content/worlds/*/building-a-world.mdx` for the author-facing version.
