# @workflow/world-postgres

## 4.1.0-beta.35

### Patch Changes

- [#1057](https://github.com/vercel/workflow/pull/1057) [`5e06a7c`](https://github.com/vercel/workflow/commit/5e06a7c8332042a4835fa0e469e1031fec742668) Thanks [@pranaygp](https://github.com/pranaygp)! - Materialize waits as entities to prevent duplicate wait_completed events
  - `@workflow/core`: Handle 409 conflict gracefully when creating wait_completed events, preventing crashes when multiple concurrent invocations race to complete the same wait
  - `@workflow/world`: Add `Wait` type, `WaitSchema`, and `WaitStatusSchema` exports; add optional `wait` field to `EventResult`
  - `@workflow/world-local`: Materialize wait entities on wait_created/wait_completed with duplicate detection; clean up waits on terminal run states
  - `@workflow/world-postgres`: Add `workflow_waits` table with `wait_status` enum; materialize wait entities with conditional writes for duplicate prevention; clean up waits on terminal run states

- [#1081](https://github.com/vercel/workflow/pull/1081) [`5487983`](https://github.com/vercel/workflow/commit/54879835f390299f9249523e0488bbdca708fb68) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Implement `World.close()` to stop PgBoss and close the postgres connection pool so the process can exit cleanly

- Updated dependencies [[`c2b4fe9`](https://github.com/vercel/workflow/commit/c2b4fe9906fd0845fef646669034cd203d97a18d), [`6e72b29`](https://github.com/vercel/workflow/commit/6e72b295e71c1a9e0a91dbe1137eca7b88227e1f), [`5e06a7c`](https://github.com/vercel/workflow/commit/5e06a7c8332042a4835fa0e469e1031fec742668), [`5487983`](https://github.com/vercel/workflow/commit/54879835f390299f9249523e0488bbdca708fb68), [`5487983`](https://github.com/vercel/workflow/commit/54879835f390299f9249523e0488bbdca708fb68)]:
  - @workflow/errors@4.1.0-beta.16
  - @workflow/world@4.1.0-beta.5
  - @workflow/world-local@4.1.0-beta.33

## 4.1.0-beta.34

### Patch Changes

- Updated dependencies [[`63caf93`](https://github.com/vercel/workflow/commit/63caf931380b8211f1948cf44eac7532f33e660d)]:
  - @workflow/world-local@4.1.0-beta.32

## 4.1.0-beta.33

### Patch Changes

- Updated dependencies [[`56f2221`](https://github.com/vercel/workflow/commit/56f22219b338a5a2c29466798a5ad36a6a450498)]:
  - @workflow/errors@4.1.0-beta.15
  - @workflow/world@4.1.0-beta.4
  - @workflow/world-local@4.1.0-beta.31

## 4.1.0-beta.32

### Patch Changes

- Updated dependencies [[`d9e9859`](https://github.com/vercel/workflow/commit/d9e98590fae17fd090e0be4f0b54bbaa80c7be69)]:
  - @workflow/world@4.1.0-beta.3
  - @workflow/errors@4.1.0-beta.14
  - @workflow/world-local@4.1.0-beta.30

## 4.1.0-beta.31

### Patch Changes

- [#867](https://github.com/vercel/workflow/pull/867) [`c54ba21`](https://github.com/vercel/workflow/commit/c54ba21c19040577ed95f6264a2670f190e1d1d3) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add optional `writeToStreamMulti` function to the World interface

- [#932](https://github.com/vercel/workflow/pull/932) [`088de0a`](https://github.com/vercel/workflow/commit/088de0ae422bb7c958109d689127691cea5753b6) Thanks [@pranaygp](https://github.com/pranaygp)! - Optimize step handler performance and improve server-side validation
  - Skip initial `world.steps.get()` call in step handler (saves one HTTP round-trip)
  - Add server-side `retryAfter` validation to local and postgres worlds (HTTP 425 when not reached)
  - Fix HTTP status code for step terminal state: return 409 (Conflict) instead of 410
  - Fix race condition: await `step_started` event before hydration to ensure correct attempt count

- Updated dependencies [[`0ce46b9`](https://github.com/vercel/workflow/commit/0ce46b91d9c8ca3349f43cdf3a5d75a948d6f5ad), [`c54ba21`](https://github.com/vercel/workflow/commit/c54ba21c19040577ed95f6264a2670f190e1d1d3), [`088de0a`](https://github.com/vercel/workflow/commit/088de0ae422bb7c958109d689127691cea5753b6), [`088de0a`](https://github.com/vercel/workflow/commit/088de0ae422bb7c958109d689127691cea5753b6)]:
  - @workflow/world@4.1.0-beta.2
  - @workflow/world-local@4.1.0-beta.29
  - @workflow/errors@4.1.0-beta.14

## 4.1.0-beta.30

### Minor Changes

- [#621](https://github.com/vercel/workflow/pull/621) [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae) Thanks [@pranaygp](https://github.com/pranaygp)! - **BREAKING**: Storage interface is now read-only; all mutations go through `events.create()`
  - Remove `cancel`, `pause`, `resume` from `runs`
  - Remove `create`, `update` from `runs`, `steps`, `hooks`
  - Add run lifecycle events: `run_created`, `run_started`, `run_completed`, `run_failed`, `run_cancelled`
  - Add `step_created` event type
  - Remove `fatal` field from `step_failed` (terminal failure is now implicit)
  - Add `step_retrying` event with error info for retriable failures

### Patch Changes

- [#621](https://github.com/vercel/workflow/pull/621) [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae) Thanks [@pranaygp](https://github.com/pranaygp)! - Add backwards compatibility for runs created with different spec versions
  - Add `RunNotSupportedError` for runs requiring newer world versions
  - Add semver-based version comparison utilities
  - Legacy runs (< 4.1): route to legacy handlers
  - `run_cancelled`: skip event storage, directly update run
  - `wait_completed`: store event only (no entity mutation)
  - Unknown legacy events: throw error

- [#853](https://github.com/vercel/workflow/pull/853) [`1060f9d`](https://github.com/vercel/workflow/commit/1060f9d04a372bf6de6c5c3d52063bcc22dba6e8) Thanks [@TooTallNate](https://github.com/TooTallNate)! - **BREAKING CHANGE**: Change user input/output to be binary data (Uint8Array) at the World interface

  This is part of specVersion 2 changes where serialization of workflow and step data uses binary format instead of JSON arrays. This allows the workflow client to be fully responsible for the data serialization format and enables future enhancements such as encryption and compression without the World implementation needing to care about the underlying data representation.

- [#621](https://github.com/vercel/workflow/pull/621) [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae) Thanks [@pranaygp](https://github.com/pranaygp)! - Remove deprecated `workflow_completed`, `workflow_failed`, and `workflow_started` events in favor of `run_completed`, `run_failed`, and `run_started` events.

- [#621](https://github.com/vercel/workflow/pull/621) [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae) Thanks [@pranaygp](https://github.com/pranaygp)! - Add `specVersion` property to World interface
  - All worlds expose `@workflow/world` package version for protocol compatibility
  - Stored in `run_created` event and `WorkflowRun` schema
  - Displayed in observability UI

- [#621](https://github.com/vercel/workflow/pull/621) [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae) Thanks [@pranaygp](https://github.com/pranaygp)! - Implement event-sourced entity creation in `events.create()`
  - Atomically create run/step/hook entities when processing corresponding events
  - Return `hook_conflict` event when hook token already exists
  - Add `spec_version` column to runs table

- Updated dependencies [[`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae), [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae), [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae), [`1060f9d`](https://github.com/vercel/workflow/commit/1060f9d04a372bf6de6c5c3d52063bcc22dba6e8), [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae), [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae), [`57f6376`](https://github.com/vercel/workflow/commit/57f637653d3790b9a77b2cd072bcf02fa6b61d74), [`60a9b76`](https://github.com/vercel/workflow/commit/60a9b7661a86b6bd44c25cddf68cadf0515f195e), [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae)]:
  - @workflow/world@4.1.0-beta.1
  - @workflow/world-local@4.1.0-beta.28
  - @workflow/errors@4.1.0-beta.14

## 4.1.0-beta.29

### Patch Changes

- [#804](https://github.com/vercel/workflow/pull/804) [`1533dbb`](https://github.com/vercel/workflow/commit/1533dbbf44e94a36c9f15b190fccdd7f0040a89a) Thanks [@lcneves](https://github.com/lcneves)! - Delete redundant and bugged Drizzle migration

- Updated dependencies [[`202c524`](https://github.com/vercel/workflow/commit/202c524723932fc5342d33f4b57d26c25c7f9e64), [`5ba82ec`](https://github.com/vercel/workflow/commit/5ba82ec4b105d11538be6ad65449986eaf945916), [`b05dbd7`](https://github.com/vercel/workflow/commit/b05dbd7525c1a4b4027a28e0f4eae9da87ea5788)]:
  - @workflow/world-local@4.0.1-beta.27

## 4.1.0-beta.28

### Patch Changes

- Updated dependencies [[`61fdb41`](https://github.com/vercel/workflow/commit/61fdb41e1b5cd52c7b23fa3c0f3fcaa50c4189ca), [`0aa835f`](https://github.com/vercel/workflow/commit/0aa835fe30d4d61e2d6dcde693d6fbb24be72c66)]:
  - @workflow/world@4.0.1-beta.13
  - @workflow/errors@4.0.1-beta.13
  - @workflow/world-local@4.0.1-beta.26

## 4.1.0-beta.27

### Patch Changes

- Updated dependencies [[`dd3db13`](https://github.com/vercel/workflow/commit/dd3db13d5498622284ed97c1a273d2942478b167)]:
  - @workflow/world@4.0.1-beta.12
  - @workflow/world-local@4.0.1-beta.25
  - @workflow/errors@4.0.1-beta.13

## 4.1.0-beta.26

### Patch Changes

- Updated dependencies []:
  - @workflow/errors@4.0.1-beta.13
  - @workflow/world-local@4.0.1-beta.24

## 4.1.0-beta.25

### Patch Changes

- Updated dependencies [[`2dbe494`](https://github.com/vercel/workflow/commit/2dbe49495dd4fae22edc53e190952c8f15289b8b)]:
  - @workflow/world-local@4.0.1-beta.23

## 4.1.0-beta.24

### Patch Changes

- [#455](https://github.com/vercel/workflow/pull/455) [`e3f0390`](https://github.com/vercel/workflow/commit/e3f0390469b15f54dee7aa9faf753cb7847a60c6) Thanks [@karthikscale3](https://github.com/karthikscale3)! - Added Control Flow Graph extraction from Workflows and extended manifest.json's schema to incorporate the graph structure into it. Refactored manifest generation to pass manifest as a parameter instead of using instance state. Add e2e tests for manifest validation across all builders.

- Updated dependencies [[`e3f0390`](https://github.com/vercel/workflow/commit/e3f0390469b15f54dee7aa9faf753cb7847a60c6)]:
  - @workflow/world-local@4.0.1-beta.22
  - @workflow/world@4.0.1-beta.11
  - @workflow/errors@4.0.1-beta.12

## 4.1.0-beta.23

### Patch Changes

- Updated dependencies [[`d9f6a49`](https://github.com/vercel/workflow/commit/d9f6a4939760be94dfc9eaf77dcaa48c602c18ef), [`c3464bf`](https://github.com/vercel/workflow/commit/c3464bfd978a073f6d8fca95208bd053aa5c78dd)]:
  - @workflow/world-local@4.0.1-beta.21
  - @workflow/errors@4.0.1-beta.11

## 4.1.0-beta.22

### Patch Changes

- Updated dependencies [[`f2d5997`](https://github.com/vercel/workflow/commit/f2d5997b800d6c474bb93d4ddd82cf52489752da)]:
  - @workflow/world-local@4.0.1-beta.20

## 4.1.0-beta.21

### Patch Changes

- [#625](https://github.com/vercel/workflow/pull/625) [`712f6f8`](https://github.com/vercel/workflow/commit/712f6f86b1804c82d4cab3bba0db49584451d005) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - List implicitly passed streams for `world.listStreamsByRun`

- Updated dependencies [[`ce7d428`](https://github.com/vercel/workflow/commit/ce7d428a07cd415d2ea64c779b84ecdc796927a0), [`712f6f8`](https://github.com/vercel/workflow/commit/712f6f86b1804c82d4cab3bba0db49584451d005), [`4bdd3e5`](https://github.com/vercel/workflow/commit/4bdd3e5086a51a46898cca774533019d3ace77b3)]:
  - @workflow/world-local@4.0.1-beta.19
  - @workflow/errors@4.0.1-beta.10

## 4.1.0-beta.20

### Patch Changes

- Updated dependencies [[`b56aae3`](https://github.com/vercel/workflow/commit/b56aae3fe9b5568d7bdda592ed025b3499149240)]:
  - @workflow/errors@4.0.1-beta.9
  - @workflow/world-local@4.0.1-beta.18

## 4.1.0-beta.19

### Patch Changes

- Updated dependencies [[`c9b8d84`](https://github.com/vercel/workflow/commit/c9b8d843fd0a88de268d603a14ebe2e7c726169a)]:
  - @workflow/world-local@4.0.1-beta.17
  - @workflow/errors@4.0.1-beta.8

## 4.1.0-beta.18

### Patch Changes

- [#574](https://github.com/vercel/workflow/pull/574) [`c82b467`](https://github.com/vercel/workflow/commit/c82b46720cf6284f3c7e3ded107e1d8321f6e705) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Add listByRunId endpoint to Streamer interface

- Updated dependencies [[`d42a968`](https://github.com/vercel/workflow/commit/d42a9681a1c7139ac5ed2973b1738d8a9000a1b6), [`c82b467`](https://github.com/vercel/workflow/commit/c82b46720cf6284f3c7e3ded107e1d8321f6e705)]:
  - @workflow/world-local@4.0.1-beta.16
  - @workflow/world@4.0.1-beta.10
  - @workflow/errors@4.0.1-beta.7

## 4.1.0-beta.17

### Patch Changes

- Updated dependencies [48b3a12]
- Updated dependencies [57a2c32]
  - @workflow/world-local@4.0.1-beta.15
  - @workflow/world@4.0.1-beta.9
  - @workflow/errors@4.0.1-beta.7

## 4.1.0-beta.16

### Patch Changes

- ef8e0e5: Increase polling interval for pg-boss to reduce interval between steps
- 8d4562e: Rename leftover references to "embedded world" to be "local world"
- Updated dependencies [6e8e828]
- Updated dependencies [10c5b91]
- Updated dependencies [bdde1bd]
- Updated dependencies [2faddf3]
- Updated dependencies [8d4562e]
  - @workflow/world-local@4.0.1-beta.14
  - @workflow/world@4.0.1-beta.8
  - @workflow/errors@4.0.1-beta.7

## 4.1.0-beta.15

### Patch Changes

- Updated dependencies [fb9fd0f]
- Updated dependencies [40057db]
  - @workflow/world@4.0.1-beta.7
  - @workflow/world-local@4.0.1-beta.13
  - @workflow/errors@4.0.1-beta.6

## 4.1.0-beta.14

### Patch Changes

- Updated dependencies [edb69c3]
  - @workflow/world-local@4.0.1-beta.12
  - @workflow/errors@4.0.1-beta.6

## 4.1.0-beta.13

### Patch Changes

- Updated dependencies [3436629]
  - @workflow/world-local@4.0.1-beta.11

## 4.1.0-beta.12

### Patch Changes

- 3d99d6d: Update `@vercel/oidc` and `@vercel/queue` to fix expired OIDC token edge case
- Updated dependencies [3d99d6d]
  - @workflow/world-local@5.0.0-beta.10

## 4.1.0-beta.11

### Patch Changes

- 4b70739: Require specifying runId when writing to stream
- Updated dependencies [4b70739]
  - @workflow/world-local@5.0.0-beta.9
  - @workflow/world@4.0.1-beta.6
  - @workflow/errors@4.0.1-beta.5

## 4.1.0-beta.10

### Patch Changes

- 5790cb2: Use drizzle migrator
- b97b6bf: Lock all dependencies in our packages
- 00b0bb9: Support structured errors for steps and runs
- a6f5545: Update migration and parse data through schemas
- 79480f2: Clean up Hook entities after a workflow run has completed
- Updated dependencies [aa015af]
- Updated dependencies [00b0bb9]
- Updated dependencies [b97b6bf]
- Updated dependencies [00b0bb9]
- Updated dependencies [00b0bb9]
- Updated dependencies [79480f2]
  - @workflow/world-local@5.0.0-beta.8
  - @workflow/errors@4.0.1-beta.5
  - @workflow/world@4.0.1-beta.5

## 4.1.0-beta.9

### Patch Changes

- Updated dependencies [2b880f9]
- Updated dependencies [68363b2]
  - @workflow/world-local@4.0.1-beta.7

## 4.1.0-beta.8

### Patch Changes

- Updated dependencies [adf0cfe]
  - @workflow/world-local@4.0.1-beta.6
  - @workflow/errors@4.0.1-beta.4

## 4.1.0-beta.7

### Patch Changes

- 8a82ec5: Bug fixes and test coverage for Storage.ts in Postgres World

## 4.1.0-beta.6

### Patch Changes

- Updated dependencies [05714f7]
  - @workflow/world-local@4.0.1-beta.5

## 4.1.0-beta.5

### Patch Changes

- f973954: Update license to Apache 2.0
- Updated dependencies [10309c3]
- Updated dependencies [f973954]
  - @workflow/world-local@4.0.1-beta.4
  - @workflow/errors@4.0.1-beta.3
  - @workflow/world@4.0.1-beta.4

## 4.1.0-beta.4

### Minor Changes

- 3dd25de: Exported the database schema and added a script for initializing the database with all the required tables for the setup.

### Patch Changes

- 20d51f0: Add optional `retryAfter` property to `Step` interface
- Updated dependencies [796fafd]
- Updated dependencies [20d51f0]
- Updated dependencies [20d51f0]
- Updated dependencies [70be894]
  - @workflow/errors@4.0.1-beta.2
  - @workflow/world-local@4.0.1-beta.3
  - @workflow/world@4.0.1-beta.3

## 4.0.1-beta.3

### Patch Changes

- ae0972f: Fix build script to include the built files

## 4.0.1-beta.2

### Patch Changes

- 7868434: Remove `AuthProvider` interface from `World` and associated implementations
- Updated dependencies [d3a4ed3]
- Updated dependencies [d3a4ed3]
- Updated dependencies [66225bf]
- Updated dependencies [7868434]
  - @workflow/world@4.0.1-beta.2
  - @workflow/world-local@4.0.1-beta.2

## 4.0.1-beta.1

### Patch Changes

- e46294f: Add "license" and "repository" fields to `package.json` file
- Updated dependencies [1408293]
- Updated dependencies [8422a32]
- Updated dependencies [e46294f]
  - @workflow/world-local@4.0.1-beta.1
  - @workflow/errors@4.0.1-beta.1
  - @workflow/world@4.0.1-beta.1

## 4.0.1-beta.0

### Patch Changes

- fcf63d0: Initial publish
- Updated dependencies [fcf63d0]
  - @workflow/world-local@4.0.1-beta.0
  - @workflow/errors@4.0.1-beta.0
  - @workflow/world@4.0.1-beta.0
