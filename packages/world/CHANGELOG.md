# @workflow/world

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
