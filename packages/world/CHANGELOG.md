# @workflow/world

## 4.1.0-beta.5

### Patch Changes

- [#979](https://github.com/vercel/workflow/pull/979) [`6e72b29`](https://github.com/vercel/workflow/commit/6e72b295e71c1a9e0a91dbe1137eca7b88227e1f) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add `World.getEncryptionKeyForRun()` and thread encryption key through serialization layer

- [#1057](https://github.com/vercel/workflow/pull/1057) [`5e06a7c`](https://github.com/vercel/workflow/commit/5e06a7c8332042a4835fa0e469e1031fec742668) Thanks [@pranaygp](https://github.com/pranaygp)! - Materialize waits as entities to prevent duplicate wait_completed events
  - `@workflow/core`: Handle 409 conflict gracefully when creating wait_completed events, preventing crashes when multiple concurrent invocations race to complete the same wait
  - `@workflow/world`: Add `Wait` type, `WaitSchema`, and `WaitStatusSchema` exports; add optional `wait` field to `EventResult`
  - `@workflow/world-local`: Materialize wait entities on wait_created/wait_completed with duplicate detection; clean up waits on terminal run states
  - `@workflow/world-postgres`: Add `workflow_waits` table with `wait_status` enum; materialize wait entities with conditional writes for duplicate prevention; clean up waits on terminal run states

- [#1081](https://github.com/vercel/workflow/pull/1081) [`5487983`](https://github.com/vercel/workflow/commit/54879835f390299f9249523e0488bbdca708fb68) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add optional `close()` method to the `World` interface for releasing resources held by a World implementation

## 4.1.0-beta.4

### Patch Changes

- [#966](https://github.com/vercel/workflow/pull/966) [`56f2221`](https://github.com/vercel/workflow/commit/56f22219b338a5a2c29466798a5ad36a6a450498) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Add 429 throttle retry handling and 500 server error retry with exponential backoff to the workflow and step runtimes

## 4.1.0-beta.3

### Patch Changes

- [#954](https://github.com/vercel/workflow/pull/954) [`d9e9859`](https://github.com/vercel/workflow/commit/d9e98590fae17fd090e0be4f0b54bbaa80c7be69) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Generate runId client-side in start() and simplify runId types

  The `runId` is now generated client-side using ULID before serialization, rather than waiting for the server response. This simplifies the `Streamer` interface and `WorkflowServerWritableStream` to accept `string` instead of `string | Promise<string>` for `runId`.

## 4.1.0-beta.2

### Patch Changes

- [#922](https://github.com/vercel/workflow/pull/922) [`0ce46b9`](https://github.com/vercel/workflow/commit/0ce46b91d9c8ca3349f43cdf3a5d75a948d6f5ad) Thanks [@pranaygp](https://github.com/pranaygp)! - Add support for custom headers in queue messages

- [#867](https://github.com/vercel/workflow/pull/867) [`c54ba21`](https://github.com/vercel/workflow/commit/c54ba21c19040577ed95f6264a2670f190e1d1d3) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add optional `writeToStreamMulti` function to the World interface

## 4.1.0-beta.1

### Minor Changes

- [#621](https://github.com/vercel/workflow/pull/621) [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae) Thanks [@pranaygp](https://github.com/pranaygp)! - Add backwards compatibility for runs created with different spec versions
  - Add `RunNotSupportedError` for runs requiring newer world versions
  - Add semver-based version comparison utilities
  - Legacy runs (< 4.1): route to legacy handlers
  - `run_cancelled`: skip event storage, directly update run
  - `wait_completed`: store event only (no entity mutation)
  - Unknown legacy events: throw error

- [#621](https://github.com/vercel/workflow/pull/621) [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae) Thanks [@pranaygp](https://github.com/pranaygp)! - **BREAKING**: Storage interface is now read-only; all mutations go through `events.create()`
  - Remove `cancel`, `pause`, `resume` from `runs`
  - Remove `create`, `update` from `runs`, `steps`, `hooks`
  - Add run lifecycle events: `run_created`, `run_started`, `run_completed`, `run_failed`, `run_cancelled`
  - Add `step_created` event type
  - Remove `fatal` field from `step_failed` (terminal failure is now implicit)
  - Add `step_retrying` event with error info for retriable failures

### Patch Changes

- [#621](https://github.com/vercel/workflow/pull/621) [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae) Thanks [@pranaygp](https://github.com/pranaygp)! - Add `hook_conflict` event type for duplicate token detection
  - World returns `hook_conflict` event when `hook_created` uses an existing token
  - Add `HOOK_CONFLICT` error slug

- [#853](https://github.com/vercel/workflow/pull/853) [`1060f9d`](https://github.com/vercel/workflow/commit/1060f9d04a372bf6de6c5c3d52063bcc22dba6e8) Thanks [@TooTallNate](https://github.com/TooTallNate)! - **BREAKING CHANGE**: Change user input/output to be binary data (Uint8Array) at the World interface

  This is part of specVersion 2 changes where serialization of workflow and step data uses binary format instead of JSON arrays. This allows the workflow client to be fully responsible for the data serialization format and enables future enhancements such as encryption and compression without the World implementation needing to care about the underlying data representation.

- [#621](https://github.com/vercel/workflow/pull/621) [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae) Thanks [@pranaygp](https://github.com/pranaygp)! - Remove deprecated `workflow_completed`, `workflow_failed`, and `workflow_started` events in favor of `run_completed`, `run_failed`, and `run_started` events.

- [#621](https://github.com/vercel/workflow/pull/621) [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae) Thanks [@pranaygp](https://github.com/pranaygp)! - Add `specVersion` property to World interface
  - All worlds expose `@workflow/world` package version for protocol compatibility
  - Stored in `run_created` event and `WorkflowRun` schema
  - Displayed in observability UI

## 4.0.1-beta.13

### Patch Changes

- [#743](https://github.com/vercel/workflow/pull/743) [`61fdb41`](https://github.com/vercel/workflow/commit/61fdb41e1b5cd52c7b23fa3c0f3fcaa50c4189ca) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add `HealthCheckPayloadSchema`

- [#772](https://github.com/vercel/workflow/pull/772) [`0aa835f`](https://github.com/vercel/workflow/commit/0aa835fe30d4d61e2d6dcde693d6fbb24be72c66) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add typedoc comments to `Hook` interface

## 4.0.1-beta.12

### Patch Changes

- [#751](https://github.com/vercel/workflow/pull/751) [`dd3db13`](https://github.com/vercel/workflow/commit/dd3db13d5498622284ed97c1a273d2942478b167) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Remove the unused paused/resumed run events and states
  - Remove `run_paused` and `run_resumed` event types
  - Remove `paused` status from `WorkflowRunStatus`
  - Remove `PauseWorkflowRunParams` and `ResumeWorkflowRunParams` types
  - Remove `pauseWorkflowRun` and `resumeWorkflowRun` functions from world-vercel

## 4.0.1-beta.11

### Patch Changes

- [#455](https://github.com/vercel/workflow/pull/455) [`e3f0390`](https://github.com/vercel/workflow/commit/e3f0390469b15f54dee7aa9faf753cb7847a60c6) Thanks [@karthikscale3](https://github.com/karthikscale3)! - Added Control Flow Graph extraction from Workflows and extended manifest.json's schema to incorporate the graph structure into it. Refactored manifest generation to pass manifest as a parameter instead of using instance state. Add e2e tests for manifest validation across all builders.

## 4.0.1-beta.10

### Patch Changes

- [#574](https://github.com/vercel/workflow/pull/574) [`c82b467`](https://github.com/vercel/workflow/commit/c82b46720cf6284f3c7e3ded107e1d8321f6e705) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Add listByRunId endpoint to Streamer interface

## 4.0.1-beta.9

### Patch Changes

- 57a2c32: Add expiredAt attribute to Run

## 4.0.1-beta.8

### Patch Changes

- 10c5b91: Export QueueOptions type
- bdde1bd: track queue overhead with opentelemetry

## 4.0.1-beta.7

### Patch Changes

- fb9fd0f: Add support for closure scope vars in step functions

## 4.0.1-beta.6

### Patch Changes

- 4b70739: Require specifying runId when writing to stream

## 4.0.1-beta.5

### Patch Changes

- 00b0bb9: Add error stack propogation to steps and runs

## 4.0.1-beta.4

### Patch Changes

- f973954: Update license to Apache 2.0

## 4.0.1-beta.3

### Patch Changes

- 20d51f0: Add optional `retryAfter` property to `Step` interface
- 70be894: Implement `sleep()` natively into the workflow runtime

## 4.0.1-beta.2

### Patch Changes

- d3a4ed3: Remove `@types/json-schema` dependency (not used)
- d3a4ed3: Remove `@types/node` from being a peerDependency
- 7868434: Remove `AuthProvider` interface from `World` and associated implementations

## 4.0.1-beta.1

### Patch Changes

- 8422a32: Update Workflow naming convention
- e46294f: Add "license" and "repository" fields to `package.json` file

## 4.0.1-beta.0

### Patch Changes

- fcf63d0: Initial publish
