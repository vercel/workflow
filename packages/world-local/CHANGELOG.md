# @workflow/world-local

## 4.0.1-beta.25

### Patch Changes

- [#751](https://github.com/vercel/workflow/pull/751) [`dd3db13`](https://github.com/vercel/workflow/commit/dd3db13d5498622284ed97c1a273d2942478b167) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Remove the unused paused/resumed run events and states

  - Remove `run_paused` and `run_resumed` event types
  - Remove `paused` status from `WorkflowRunStatus`
  - Remove `PauseWorkflowRunParams` and `ResumeWorkflowRunParams` types
  - Remove `pauseWorkflowRun` and `resumeWorkflowRun` functions from world-vercel

- Updated dependencies [[`dd3db13`](https://github.com/vercel/workflow/commit/dd3db13d5498622284ed97c1a273d2942478b167)]:
  - @workflow/world@4.0.1-beta.12
  - @workflow/errors@4.0.1-beta.13

## 4.0.1-beta.24

### Patch Changes

- Updated dependencies [[`9b1640d`](https://github.com/vercel/workflow/commit/9b1640d76e7e759446058d65272011071bb250d2)]:
  - @workflow/utils@4.0.1-beta.10
  - @workflow/errors@4.0.1-beta.13

## 4.0.1-beta.23

### Patch Changes

- [#704](https://github.com/vercel/workflow/pull/704) [`2dbe494`](https://github.com/vercel/workflow/commit/2dbe49495dd4fae22edc53e190952c8f15289b8b) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Fix race condition in streamer when multiple writes share a promise runId.

## 4.0.1-beta.22

### Patch Changes

- [#455](https://github.com/vercel/workflow/pull/455) [`e3f0390`](https://github.com/vercel/workflow/commit/e3f0390469b15f54dee7aa9faf753cb7847a60c6) Thanks [@karthikscale3](https://github.com/karthikscale3)! - Added Control Flow Graph extraction from Workflows and extended manifest.json's schema to incorporate the graph structure into it. Refactored manifest generation to pass manifest as a parameter instead of using instance state. Add e2e tests for manifest validation across all builders.

- Updated dependencies [[`e3f0390`](https://github.com/vercel/workflow/commit/e3f0390469b15f54dee7aa9faf753cb7847a60c6)]:
  - @workflow/utils@4.0.1-beta.9
  - @workflow/world@4.0.1-beta.11
  - @workflow/errors@4.0.1-beta.12

## 4.0.1-beta.21

### Patch Changes

- [#681](https://github.com/vercel/workflow/pull/681) [`d9f6a49`](https://github.com/vercel/workflow/commit/d9f6a4939760be94dfc9eaf77dcaa48c602c18ef) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Create dataDir on app start, and record package version to enable future migrations

- [#672](https://github.com/vercel/workflow/pull/672) [`c3464bf`](https://github.com/vercel/workflow/commit/c3464bfd978a073f6d8fca95208bd053aa5c78dd) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Fix race condition in streamer where close events arriving during disk reads would close the controller before data was enqueued. Close events are now buffered and processed after disk reads complete.

- Updated dependencies [[`0cf0ac3`](https://github.com/vercel/workflow/commit/0cf0ac32114bcdfa49319d27c2ce98da516690f1)]:
  - @workflow/utils@4.0.1-beta.8
  - @workflow/errors@4.0.1-beta.11

## 4.0.1-beta.20

### Patch Changes

- [#662](https://github.com/vercel/workflow/pull/662) [`f2d5997`](https://github.com/vercel/workflow/commit/f2d5997b800d6c474bb93d4ddd82cf52489752da) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Throw an error when trying writing JSON that fails entity validation, and remove error when trying to read JSON that fails validation, replacing it with a warning. This unblocks UI/CLI when data is invalid.

## 4.0.1-beta.19

### Patch Changes

- [#623](https://github.com/vercel/workflow/pull/623) [`ce7d428`](https://github.com/vercel/workflow/commit/ce7d428a07cd415d2ea64c779b84ecdc796927a0) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Fix local world not returning new items for live step pagination

- [#625](https://github.com/vercel/workflow/pull/625) [`712f6f8`](https://github.com/vercel/workflow/commit/712f6f86b1804c82d4cab3bba0db49584451d005) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - List implicitly passed streams for `world.listStreamsByRun`

- Updated dependencies [[`4bdd3e5`](https://github.com/vercel/workflow/commit/4bdd3e5086a51a46898cca774533019d3ace77b3)]:
  - @workflow/errors@4.0.1-beta.10

## 4.0.1-beta.18

### Patch Changes

- Updated dependencies [[`1ef6b2f`](https://github.com/vercel/workflow/commit/1ef6b2fdc8dc7e4d665aa2fe1a7d9e68ce7f1e95), [`b56aae3`](https://github.com/vercel/workflow/commit/b56aae3fe9b5568d7bdda592ed025b3499149240)]:
  - @workflow/utils@4.0.1-beta.7
  - @workflow/errors@4.0.1-beta.9

## 4.0.1-beta.17

### Patch Changes

- [#590](https://github.com/vercel/workflow/pull/590) [`c9b8d84`](https://github.com/vercel/workflow/commit/c9b8d843fd0a88de268d603a14ebe2e7c726169a) Thanks [@adriandlam](https://github.com/adriandlam)! - Improve port detection with HTTP probing

- Updated dependencies [[`c9b8d84`](https://github.com/vercel/workflow/commit/c9b8d843fd0a88de268d603a14ebe2e7c726169a)]:
  - @workflow/utils@4.0.1-beta.6
  - @workflow/errors@4.0.1-beta.8

## 4.0.1-beta.16

### Patch Changes

- [#568](https://github.com/vercel/workflow/pull/568) [`d42a968`](https://github.com/vercel/workflow/commit/d42a9681a1c7139ac5ed2973b1738d8a9000a1b6) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Bump undici dependency to latest minor version

- [#574](https://github.com/vercel/workflow/pull/574) [`c82b467`](https://github.com/vercel/workflow/commit/c82b46720cf6284f3c7e3ded107e1d8321f6e705) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Add listByRunId endpoint to Streamer interface

- Updated dependencies [[`c82b467`](https://github.com/vercel/workflow/commit/c82b46720cf6284f3c7e3ded107e1d8321f6e705)]:
  - @workflow/world@4.0.1-beta.10
  - @workflow/errors@4.0.1-beta.7

## 4.0.1-beta.15

### Patch Changes

- 48b3a12: perf: optimize for high-concurrency workflows

  - Add in-memory cache for file existence checks to avoid expensive fs.access() calls
  - Increase default concurrency limit from 20 to 100
  - Improve HTTP connection pooling with undici Agent (100 connections, 30s keepalive)

- Updated dependencies [57a2c32]
  - @workflow/world@4.0.1-beta.9
  - @workflow/errors@4.0.1-beta.7

## 4.0.1-beta.14

### Patch Changes

- 6e8e828: Silently ignore stream already closed errors
- 2faddf3: Move `@workflow/errors` package to "dependencies" instead of "devDependencies"
- 8d4562e: Rename leftover references to "embedded world" to be "local world"
- Updated dependencies [bc9b628]
- Updated dependencies [34f3f86]
- Updated dependencies [cd451e0]
- Updated dependencies [10c5b91]
- Updated dependencies [bdde1bd]
  - @workflow/utils@4.0.1-beta.5
  - @workflow/world@4.0.1-beta.8
  - @workflow/errors@4.0.1-beta.7

## 4.0.1-beta.13

### Patch Changes

- 40057db: Use a semaphore to enforce a concurrency limit on the local world queue
- Updated dependencies [fb9fd0f]
  - @workflow/world@4.0.1-beta.7

## 4.0.1-beta.12

### Patch Changes

- edb69c3: Fix port detection and base URL resolution for dev servers
- Updated dependencies [edb69c3]
  - @workflow/utils@4.0.1-beta.4

## 4.0.1-beta.11

### Patch Changes

- 3436629: Fix bugs in streamer (empty chunk handling and cloning chunks)

## 5.0.0-beta.10

### Patch Changes

- 3d99d6d: Update `@vercel/oidc` and `@vercel/queue` to fix expired OIDC token edge case

## 5.0.0-beta.9

### Patch Changes

- 4b70739: Require specifying runId when writing to stream
- Updated dependencies [4b70739]
  - @workflow/world@4.0.1-beta.6

## 5.0.0-beta.8

### Major Changes

- aa015af: BREAKING: Change `createLocalWorld` API signature from positional parameters to config object. Add baseUrl configuration support.

  **Breaking change:**

  - `createLocalWorld(dataDir?, port?)` → `createLocalWorld(args?: Partial<Config>)`

  **New features:**

  - Add `baseUrl` config option for HTTPS and custom hostnames (via config or `WORKFLOW_LOCAL_BASE_URL` env var)
  - Support for port 0 (OS-assigned port)

### Patch Changes

- 00b0bb9: Support for structured errors
- b97b6bf: Lock all dependencies in our packages
- 79480f2: Clean up Hook entities after a workflow run has completed
- Updated dependencies [b97b6bf]
- Updated dependencies [00b0bb9]
  - @workflow/utils@4.0.1-beta.3
  - @workflow/world@4.0.1-beta.5

## 4.0.1-beta.7

### Patch Changes

- 2b880f9: Enforce uniqueness on hook "token" values
- 68363b2: When paginating, return a cursor even at the end of the list, to allow for stable resumption

## 4.0.1-beta.6

### Patch Changes

- adf0cfe: Add automatic port discovery
- Updated dependencies [bf170ad]
- Updated dependencies [adf0cfe]
  - @workflow/utils@4.0.1-beta.2

## 4.0.1-beta.5

### Patch Changes

- 05714f7: Add sveltekit workflow integration

## 4.0.1-beta.4

### Patch Changes

- 10309c3: Fix long-running steps to not time out after 5 minutes
- f973954: Update license to Apache 2.0
- Updated dependencies [f973954]
  - @workflow/world@4.0.1-beta.4

## 4.0.1-beta.3

### Patch Changes

- 20d51f0: Allow `WORKFLOW_LOCAL_QUEUE_MAX_VISIBILITY` env var to set max queue visibility timeout
- Updated dependencies [20d51f0]
- Updated dependencies [70be894]
  - @workflow/world@4.0.1-beta.3

## 4.0.1-beta.2

### Patch Changes

- 66225bf: World-local: filter by workflowName/status if passed
- 7868434: Remove `AuthProvider` interface from `World` and associated implementations
- Updated dependencies [d3a4ed3]
- Updated dependencies [d3a4ed3]
- Updated dependencies [7868434]
  - @workflow/world@4.0.1-beta.2

## 4.0.1-beta.1

### Patch Changes

- 1408293: Add "description" field to `package.json` file
- e46294f: Add "license" and "repository" fields to `package.json` file
- Updated dependencies [8422a32]
- Updated dependencies [e46294f]
  - @workflow/world@4.0.1-beta.1

## 4.0.1-beta.0

### Patch Changes

- fcf63d0: Initial publish
- Updated dependencies [fcf63d0]
  - @workflow/world@4.0.1-beta.0
