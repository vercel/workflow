# Architecture

Workflow SDK is a durable functions framework for JavaScript/TypeScript that enables writing long-running, stateful application logic on top of stateless compute.

The runtime persists progress as an event log and deterministically replays code to reconstruct state after cold starts, failures, or scale events.

This repository contains the client-side SDK code for workflows, along with example apps that showcase Workflow SDK in action.

## Core components

These packages provide the runtime, integrations, backends and example applications.

- **packages/core**: Core workflow runtime and primitives (`@workflow/core`)
- **packages/next**: Next.js integration (`@workflow/next`)
- **packages/cli**: Command-line interface (`@workflow/cli`)
- **packages/world**: Core interfaces and types for workflow storage backends (`@workflow/world`)
- **packages/world-local**: Filesystem-based workflow backend for local development and testing (`@workflow/world-local`)
- **packages/world-vercel**: Production workflow backend for Vercel platform deployments (`@workflow/world-vercel`)
- **packages/swc-plugin-workflow**: SWC compiler plugin for workflow transformations
- **workbench/example**: Basic workflow examples using the CLI (aka "standalone mode")
- **workbench/nextjs-turbopack**: Workflow examples using the Next.js integration

## Workflow execution model

Workflows consist of two types of functions:

1. **Workflow functions** (`"use workflow"`): Orchestrators that run in a sandboxed VM without full Node.js access
2. **Step functions** (`"use step"`): Individual pieces of logic with full Node.js runtime access

The framework uses compiler transformations to split workflow files into separate bundles for client, workflow, and step execution contexts.

New runs default to spec 10 (a single orchestrator per run behind the World's in-band fence, plus `experimental_rateLimit()`) on Worlds that declare both the fence and rate limits (Vercel, Local, Postgres), to spec 9 on Worlds that declare only the fence, and to spec 8 on Worlds without it; `WORKFLOW_SPEC_VERSION=8` opts out. Spec 10 is capability-only on top of spec 9, so it runs on the spec 9 runtime. The spec 9 runtime lives in [[packages/core/src/runtime/spec9/|`packages/core/src/runtime/spec9/`]], and the spec 8 one in [[packages/core/src/runtime/spec8/|`packages/core/src/runtime/spec8/`]].

Design notes live as markdown next to the code they describe, not in the docs site, which never links to source files: [[packages/core/src/runtime/spec9/README.md|`packages/core/src/runtime/spec9/README.md`]] (the spec 9 reference), `packages/core/src/runtime/spec8/*.md` (turbo mode, lazy inline step start, inline step message ownership, batched event writes), `packages/core/src/runtime/*.md` (eager processing, resilient start, durable and resilient hook resume) and [[packages/core/src/attributes-mvp.md|`packages/core/src/attributes-mvp.md`]]. Read the relevant note before changing that behaviour, and update it in the same change.

## Key workflow concepts

**These are only relevant when writing code using the Workflow SDK**

- Workflow functions orchestrate step execution but have limited runtime access
- Step functions handle side effects, API calls, and complex logic with full Node.js access
- All function inputs/outputs are serialized to the event log for replay
- Built-in retry semantics for step functions with [[packages/errors/src/index.ts#FatalError|`FatalError`]]/[[packages/errors/src/index.ts#RetryableError|`RetryableError`]] controls
- Standard JavaScript async patterns work: `Promise.all()`, `Promise.race()`, etc.

## File structure conventions

**These are only relevant when writing code using the Workflow SDK**

- Workflow files go in `workflows/` directory (or `src/workflows/` if using src)
- Generated API routes appear in `app/.well-known/workflow/v1/` (Next.js integration)
- Workflow files must contain `"use workflow"` or `"use step"` directives to be processed
- Add `.swc` directory to `.gitignore` for SWC plugin cache artifacts

## Architecture notes

These notes describe shared runtime state, observability data and trace propagation constraints.

### executionContext field

The `executionContext` field on workflow runs is a flexible JSONB/CBOR object that can store arbitrary data without schema changes. It flows through all worlds (local, postgres, vercel).

### Observability data hydration

[[packages/core/src/serialization-format.ts|`packages/core/src/serialization-format.ts`]] contains [[packages/core/src/serialization-format.ts#hydrateResourceIO|`hydrateResourceIO`]] which strips certain fields (like `executionContext`) before UI display. If you need to display data from stripped fields, extract it before the stripping occurs.

### World packages must not hold mutable module state

`@workflow/world-local` and `@workflow/world-vercel` are bundled into the host
application's server build (see [[packages/next/src/index.ts#VERCEL_WORLD_DEPENDENCY_PACKAGES|`VERCEL_WORLD_DEPENDENCY_PACKAGES`]] in
[[packages/next/src/index.ts|`packages/next/src/index.ts`]]).

Bundlers key module identity on
`(resource, layer)`, and Next.js alone compiles `instrument`, app-route, `ssr`
and `edge` as separate module graphs, so one process holds one copy of every
module in these packages **per bundler layer**. A top-level `let`, or a `const`
holding a `Map`, is per-copy state, not the process singleton it reads as. A
duplicated mutex stops mutually excluding; a duplicated registry is a
deterministic miss; duplicated ID generators can fork a sequence.

Hold such state on the World instance where it is per-World, or on `globalThis`
via [[packages/utils/src/global-singleton.ts#globalSingleton|`globalSingleton()`]] from `@workflow/utils` where it is genuinely
process-wide. State that is deliberately per-copy needs a
`// per-copy-ok: <why>` annotation. [[scripts/lint/module-scope-state.mjs|`scripts/lint/module-scope-state.mjs`]]
enforces this across every published `packages/world-*`, run from
`@workflow/utils`'s test suite (with a local mirror in each world package), so
adding a new world package is covered automatically.

Custom worlds loaded through `WORKFLOW_TARGET_WORLD` are deduped by Node's
module cache and are safe today, but that is a property of how they are loaded,
not of how they are written, and it changed for world-vercel in #3493. Keep them
clean too. The author-facing version of this rule is in
`docs/content/worlds/{v4,v5}/building-a-world.mdx`; keep both versions in sync.

The sweep covers every package that ends up inside the host application's
server build: all published `packages/world-*` (discovered at runtime, so a new
world is covered the day it is added) plus `core`, `world`, `ai` and `nest`,
which are named in [[packages/utils/src/module-scope-state.test.ts#BUNDLED_RUNTIME_PACKAGES|`BUNDLED_RUNTIME_PACKAGES`]] in
[[packages/utils/src/module-scope-state.test.ts|`packages/utils/src/module-scope-state.test.ts`]]. Adding a package that runs in
the host server means adding it to that list: "does this run inside the host's
server bundle" is a judgement, not something to infer from a directory name.

Deliberately outside the sweep, because a single module graph makes the hazard
impossible: `next`, `builders` and `sveltekit` (build-time code), `cli` (its own
process), `web` and `web-shared` (the observability UI), `vitest` (the test
runner's process), and private packages such as `world-sim`.

### Trace context propagation (world-vercel HTTP requests)

Every outgoing HTTP request from `@workflow/world-vercel` to the backend (or the queue) MUST explicitly inject W3C trace context so the server can parent its spans to the caller and traces stay correlated end to end.

Call [[packages/world-vercel/src/telemetry.ts#injectTraceContextIntoHeaders|`injectTraceContextIntoHeaders(headers)`]] (from [[packages/world-vercel/src/telemetry.ts|`packages/world-vercel/src/telemetry.ts`]]) on the outgoing headers, inside the client span when one exists. [[packages/world-vercel/src/utils.ts#makeRequest|`makeRequest`]] in [[packages/world-vercel/src/utils.ts|`utils.ts`]] is the reference implementation. It is a no-op when no OpenTelemetry SDK is registered.

Do **not** rely on ambient OpenTelemetry auto-instrumentation to do this: world-vercel's request paths use custom undici dispatchers / `global fetch`, which auto-instrumentation does not reliably hook. When you add a new request path or API version (e.g. a future v5 events API), wire the injection in the same place you build the request headers. The v4 events path ([[packages/world-vercel/src/events-v4.ts#fetchV4|`fetchV4`]] in [[packages/world-vercel/src/events-v4.ts|`events-v4.ts`]]) regressed cross-service correlation precisely by routing around [[packages/world-vercel/src/utils.ts#makeRequest|`makeRequest`]] and skipping this step. Backend spans stopped joining the flow-route invocation trace until the injection was added back. Cover new paths with a test in [[packages/world-vercel/src/trace-propagation.test.ts|`trace-propagation.test.ts`]].

The same rule covers a request path that is not an HTTP request. A non-`fetch` transport must still open the client span callers read a trace through: use [[packages/world-vercel/src/http-core.ts#withHttpClientSpan|`withHttpClientSpan`]] ([[packages/world-vercel/src/http-core.ts|`http-core.ts`]]), the envelope [[packages/world-vercel/src/http-core.ts#instrumentedFetch|`instrumentedFetch`]] is built on, so the span carries the same name, kind, and attributes rather than a hand-rolled parallel shape. The WS events transport is the worked example. [[packages/world-vercel/src/events-v4.ts#postEventFrameOverWs|`postEventFrameOverWs`]] synthesizes an `http POST` span per frame and tags it `workflow.events.transport: 'ws'`, and the handshake gets its own `workflow.events.ws.connect` span ([[packages/world-vercel/src/ws-transport-spans.test.ts|`ws-transport-spans.test.ts`]]). Adding a transport that writes events without one silently deletes the per-event view of a run.
