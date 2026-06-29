# @workflow/utils

## 5.0.0-beta.4

### Minor Changes

- [#2363](https://github.com/vercel/workflow/pull/2363) [`926a5e7`](https://github.com/vercel/workflow/commit/926a5e7c6a50c1e74f2e2cc37324caa0f6442d85) Thanks [@karthikscale3](https://github.com/karthikscale3)! - Add `WORKFLOW_TRACE_MODE` with a new `linked` default: each workflow/step invocation span is now its own trace root with span links to the delivery and run-origin contexts, instead of one trace spanning the entire run. world-vercel now explicitly injects W3C `traceparent`/`tracestate`/`baggage` headers on outgoing workflow-server requests.

  Span names are also friendlier: workflow and step spans now use the short function name (e.g. `workflow.execute processOrder`, `step.execute chargeCard`, `workflow.start processOrder`) instead of the uppercase prefixes and full machine names (`WORKFLOW_V2 workflow//./src/jobs/order//processOrder`). The full name remains available in the `workflow.name` / `step.name` span attributes, and new `workflowDisplayName` / `stepDisplayName` helpers are exported from `@workflow/utils`.

  Behavioral changes to telemetry under the new default (set `WORKFLOW_TRACE_MODE=continuous` to restore the previous trace shape exactly; the span-name change applies in both modes):
  - A run no longer shares one trace ID: the trace of the request that called `start()` no longer contains the workflow's execution spans — navigate via span links or the `workflow.run.id` attribute instead.
  - Sampling decisions are made independently per invocation root (previously one parent-based decision covered the whole run), and the number of root spans/traces increases to one per invocation.
  - `workflow.execute`/`step.execute` invocation spans (formerly `WORKFLOW_V2`/`STEP`) become parentless roots, which changes parent/child-based queries and service-map edges.
  - Re-enqueued queue messages forward the original run-origin trace carrier unchanged, rather than each invocation's current context.
  - Queries or dashboards matching the old `WORKFLOW_V2 ...`/`STEP ...` span names must switch to the new names.
  - The queue-delivered `workflow.execute` span kind changed from `internal` to `consumer`, matching the queue-delivered `step.execute` span (this applies in both modes).

  Existing attributes and baggage keys are unchanged, and everything remains a no-op when no OpenTelemetry SDK is registered.

## 5.0.0-beta.3

### Patch Changes

- [#1799](https://github.com/vercel/workflow/pull/1799) [`503a929`](https://github.com/vercel/workflow/commit/503a929d347df46eb0ad63b068da7781762d0dc8) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Use inline sourcemaps for all workspace packages; published packages no longer ship external `.js.map` files.

## 5.0.0-beta.2

### Patch Changes

- [#1849](https://github.com/vercel/workflow/pull/1849) [`1203dae`](https://github.com/vercel/workflow/commit/1203dae70c802eef114909e9476e19ec528550cd) Thanks [@pranaygp](https://github.com/pranaygp)! - Friendlier workflow error messages. New `SerializationError`, `WorkflowBuildError`, and structured context-violation classes (e.g. `NotInWorkflowContextError`) with actionable hints and docs links applied to user-facing throw sites; `FatalError.is()` recognizes any error with `fatal: true` so context violations and serialization failures now fail fast instead of burning retry attempts. Runtime logs are namespaced under `[workflow-sdk]` and gain `errorAttribution` (`user` vs `sdk`) plus class-aware hints

## 5.0.0-beta.1

### Patch Changes

- [#1769](https://github.com/vercel/workflow/pull/1769) [`5a42964`](https://github.com/vercel/workflow/commit/5a4296412f151c255a8d08c8870e511222c7c472) Thanks [@tomdale](https://github.com/tomdale)! - Embed source content in published sourcemaps.

- [#1759](https://github.com/vercel/workflow/pull/1759) [`173756d`](https://github.com/vercel/workflow/commit/173756dc4d097fd90432e2c38c91ce1b959a6352) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Rename `useworkflow.dev` URLs to `workflow-sdk.dev`

## 5.0.0-beta.0

### Major Changes

- [#1642](https://github.com/vercel/workflow/pull/1642) [`c5cdfc0`](https://github.com/vercel/workflow/commit/c5cdfc00751c5bef36c4be748d819081b934fbcd) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Initial v5 beta release

## 4.1.0-beta.13

### Patch Changes

- [#1217](https://github.com/vercel/workflow/pull/1217) [`e55c636`](https://github.com/vercel/workflow/commit/e55c63678b15b6687cc77efca705ee9fb40fabc3) Thanks [@pranaygp](https://github.com/pranaygp)! - Upgrade dependencies across all packages

## 4.1.0-beta.12

### Patch Changes

- [#998](https://github.com/vercel/workflow/pull/998) [`3d770d5`](https://github.com/vercel/workflow/commit/3d770d53855ce7c8522d4f0afbdbc123eae6c1ee) Thanks [@ijjk](https://github.com/ijjk)! - Expose workflows manifest under diagnostics folder

## 4.1.0-beta.11

### Minor Changes

- [#621](https://github.com/vercel/workflow/pull/621) [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae) Thanks [@pranaygp](https://github.com/pranaygp)! - **BREAKING**: Storage interface is now read-only; all mutations go through `events.create()`
  - Remove `cancel`, `pause`, `resume` from `runs`
  - Remove `create`, `update` from `runs`, `steps`, `hooks`
  - Add run lifecycle events: `run_created`, `run_started`, `run_completed`, `run_failed`, `run_cancelled`
  - Add `step_created` event type
  - Remove `fatal` field from `step_failed` (terminal failure is now implicit)
  - Add `step_retrying` event with error info for retriable failures

### Patch Changes

- [#814](https://github.com/vercel/workflow/pull/814) [`b16a682`](https://github.com/vercel/workflow/commit/b16a6828af36a2d5adb38fb6a6d1253657001ac8) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Move "parse-name" into the `utils` package

## 4.0.1-beta.10

### Patch Changes

- [#703](https://github.com/vercel/workflow/pull/703) [`9b1640d`](https://github.com/vercel/workflow/commit/9b1640d76e7e759446058d65272011071bb250d2) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add `pluralize()` util function

## 4.0.1-beta.9

### Patch Changes

- [#455](https://github.com/vercel/workflow/pull/455) [`e3f0390`](https://github.com/vercel/workflow/commit/e3f0390469b15f54dee7aa9faf753cb7847a60c6) Thanks [@karthikscale3](https://github.com/karthikscale3)! - Added Control Flow Graph extraction from Workflows and extended manifest.json's schema to incorporate the graph structure into it. Refactored manifest generation to pass manifest as a parameter instead of using instance state. Add e2e tests for manifest validation across all builders.

## 4.0.1-beta.8

### Patch Changes

- [#682](https://github.com/vercel/workflow/pull/682) [`0cf0ac3`](https://github.com/vercel/workflow/commit/0cf0ac32114bcdfa49319d27c2ce98da516690f1) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Extract helper to find local world dataDir across CLI/web projects

## 4.0.1-beta.7

### Patch Changes

- [#616](https://github.com/vercel/workflow/pull/616) [`1ef6b2f`](https://github.com/vercel/workflow/commit/1ef6b2fdc8dc7e4d665aa2fe1a7d9e68ce7f1e95) Thanks [@adriandlam](https://github.com/adriandlam)! - Update port detection to probe workflow health check endpoint

## 4.0.1-beta.6

### Patch Changes

- [#590](https://github.com/vercel/workflow/pull/590) [`c9b8d84`](https://github.com/vercel/workflow/commit/c9b8d843fd0a88de268d603a14ebe2e7c726169a) Thanks [@adriandlam](https://github.com/adriandlam)! - Improve port detection with HTTP probing

## 4.0.1-beta.5

### Patch Changes

- bc9b628: Prevent @vercel/nft from tracing /proc paths during build
- 34f3f86: fix(utils): detect linux ports via /proc
- cd451e0: Replace execa dependency with built-in node execFile

## 4.0.1-beta.4

### Patch Changes

- edb69c3: Fix port detection and base URL resolution for dev servers

## 4.0.1-beta.3

### Patch Changes

- b97b6bf: Lock all dependencies in our packages

## 4.0.1-beta.2

### Patch Changes

- bf170ad: Add initial `@workflow/utils` package
- adf0cfe: Add automatic port discovery
