# @workflow/world

Core interfaces and types for Workflow SDK storage backends.

This package defines the `World` interface that abstracts workflow storage, queuing, authentication, and streaming operations. Implementation packages like `@workflow/world-local` and `@workflow/world-vercel` provide concrete implementations.

Used internally by `@workflow/core` and world implementations. Should not be used directly in application code.

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
