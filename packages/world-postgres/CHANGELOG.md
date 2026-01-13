# @workflow/world-postgres

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
