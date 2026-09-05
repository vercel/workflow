# Architecture

Workflow SDK is a compiler-assisted durable runtime split into public APIs, build tooling, a replay engine, pluggable Worlds, framework adapters, and observability tools.

## End-to-End Shape

Application source is compiled into host-side step registrations and sandboxed workflow code, then served by generated handlers backed by a selected World.

The main flow is:

1. A framework plugin or the CLI discovers functions marked with Workflow directives.
2. The build creates a workflow bundle, a step-registration bundle, a manifest, and route handlers.
3. `start()` serializes input, creates or requests creation of a run, and publishes a queue message pinned to a deployment.
4. The generated flow handler loads the run's event log and replays its workflow function inside a deterministic VM.
5. Already-recorded operations resolve from events. New operations suspend replay and become durable step, hook, wait, or attribute work.
6. Step bodies execute in the host runtime. Their results append events and wake another replay.
7. A World persists the log and materialized entities, dispatches queue messages, and stores streams.

See [[execution-model#Replay Cycle]] for runtime behavior and [[build-system#Generated Artifacts]] for the build outputs.

## Package Map

Packages are intentionally layered so user code, compilation, orchestration, and infrastructure can evolve with narrow contracts between them.

| Area | Packages | Responsibility |
| --- | --- | --- |
| Public surface | `workflow`, `@workflow/core`, `@workflow/errors`, `@workflow/serde`, `@workflow/utils` | User APIs, runtime primitives, shared errors, serialization symbols, and utilities |
| Compiler and builders | `@workflow/swc-plugin`, `@workflow/builders`, `@workflow/rollup`, `@workflow/typescript-plugin` | Directive discovery, source transformation, bundling, manifests, and editor diagnostics |
| Framework adapters | `@workflow/next`, `@workflow/nitro`, `@workflow/nuxt`, `@workflow/vite`, `@workflow/astro`, `@workflow/sveltekit`, `@workflow/nest` | Install transforms and expose generated routes in each host framework |
| World contract | `@workflow/world` | Events, entities, queues, streams, protocol versions, and optional capability interfaces |
| World implementations | `@workflow/world-local`, `@workflow/world-postgres`, `@workflow/world-vercel` | Filesystem development, reference self-hosting, and managed Vercel infrastructure |
| Verification Worlds | `@workflow/world-sim`, `@workflow/world-testing`, `@workflow/vitest` | Deterministic interleavings, server test support, and workflow-aware test integration |
| Product extensions | `@workflow/ai` | Durable adapters for AI SDK types and operations |
| Tooling and UI | `@workflow/cli`, `@workflow/web`, `@workflow/web-shared` | Build/run commands, inspection, and observability surfaces |

The `workbench/` applications exercise the same workflow corpus across frameworks where practical. The `docs/` application owns end-user documentation; `packages/docs-typecheck` validates its code samples.

## Runtime Boundaries

The system has three materially different execution environments, and values crossing between them must be serializable.

| Environment | Runs | Allowed behavior |
| --- | --- | --- |
| Application host | routes, server actions, CLI callers | Start, inspect, cancel, or resume runs; full host APIs |
| Workflow VM | workflow orchestration | Deterministic computation and durable primitives; no arbitrary Node.js side effects |
| Step host | step function bodies | Full Node.js and network access; retryable side effects |

The workflow VM communicates with the host through installed global hooks rather than importing host infrastructure. This keeps the bundled orchestration code portable and makes unsupported APIs fail at the semantic boundary.

## Request and Queue Boundary

Generated well-known routes are the transport boundary between a World's queue and the runtime hosted by an application deployment.

The flow route handles both orchestration messages and queued step execution. Messages identify the run and may also carry resilient creation data, trace context, retry metadata, or a step identifier. A separate webhook route converts HTTP requests into Hook resumptions.

The queue is at-least-once. Handlers acknowledge only after the durable writes needed to reproduce their decision have completed or an equivalent delayed continuation has been durably scheduled. Idempotency therefore belongs in event creation and entity transitions, not in delivery assumptions.

## Observability Boundary

Runtime storage is authoritative, while observability APIs are read-optimized and must not become a second source of truth.

Canonical payload-bearing reads remain on the World's `runs`, `steps`, `events`, `hooks`, and `streams` APIs. An optional `analytics` namespace may expose metadata-only, plan-aware queries for UI and CLI listing. Hydration and decryption occur above the World so backends remain format-agnostic.

## Repository Constraints

Several cross-cutting constraints protect behavior that bundlers and deployments can otherwise make surprising.

- Published World packages must not keep mutable module state; bundlers can instantiate the same resource once per layer. Instance state belongs on the World, and true process singletons belong on `globalThis`.
- The agent-readable documentation sitemap routes and their `llms` link are part of the documentation interface and must remain intact.
- Changes to SWC transformation behavior require matching updates to `packages/swc-plugin-workflow/spec.md`.
- User-configurable environment variables are public behavior and must be documented.
- Existing runs and rolling deployments constrain changes across the runtime, generated bundles, Worlds, and wire formats; see [[data-and-compatibility#Compatibility Strategy]].
