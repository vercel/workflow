# @workflow/world-vercel

## 4.0.1-beta.21

### Patch Changes

- [#639](https://github.com/vercel/workflow/pull/639) [`ab55ba2`](https://github.com/vercel/workflow/commit/ab55ba2d61b41e2b2cd9e213069c93be988c9b1e) Thanks [@adriandlam](https://github.com/adriandlam)! - Add custom request header to bypass RSC request memoization

- Updated dependencies [[`4bdd3e5`](https://github.com/vercel/workflow/commit/4bdd3e5086a51a46898cca774533019d3ace77b3)]:
  - @workflow/errors@4.0.1-beta.10

## 4.0.1-beta.20

### Patch Changes

- [#627](https://github.com/vercel/workflow/pull/627) [`deaf019`](https://github.com/vercel/workflow/commit/deaf0193e91ea7a24d2423a813b64f51faa681e3) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - [world-vercel] Allow skipping vercel backend proxy for e2e tests where CLI runs in runtime env

- Updated dependencies [[`b56aae3`](https://github.com/vercel/workflow/commit/b56aae3fe9b5568d7bdda592ed025b3499149240)]:
  - @workflow/errors@4.0.1-beta.9

## 4.0.1-beta.19

### Patch Changes

- Updated dependencies []:
  - @workflow/errors@4.0.1-beta.8

## 4.0.1-beta.18

### Patch Changes

- [#574](https://github.com/vercel/workflow/pull/574) [`c82b467`](https://github.com/vercel/workflow/commit/c82b46720cf6284f3c7e3ded107e1d8321f6e705) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Add listByRunId endpoint to Streamer interface

- Updated dependencies [[`c82b467`](https://github.com/vercel/workflow/commit/c82b46720cf6284f3c7e3ded107e1d8321f6e705)]:
  - @workflow/world@4.0.1-beta.10
  - @workflow/errors@4.0.1-beta.7

## 4.0.1-beta.17

### Patch Changes

- Updated dependencies [57a2c32]
  - @workflow/world@4.0.1-beta.9
  - @workflow/errors@4.0.1-beta.7

## 4.0.1-beta.16

### Patch Changes

- c8fa70a: Change Vercel queue max visibility to 11 hours

## 4.0.1-beta.15

### Patch Changes

- e9494d5: Update `@vercel/queue` to use new QueueClient class to simplify custom header/path overwrites

## 4.0.1-beta.14

### Patch Changes

- Updated dependencies [10c5b91]
- Updated dependencies [bdde1bd]
  - @workflow/world@4.0.1-beta.8
  - @workflow/errors@4.0.1-beta.7

## 4.0.1-beta.13

### Patch Changes

- Updated dependencies [fb9fd0f]
  - @workflow/world@4.0.1-beta.7
  - @workflow/errors@4.0.1-beta.6

## 4.0.1-beta.12

### Patch Changes

- 6889dac: Log warning when detecting zod v3

## 4.0.1-beta.11

### Patch Changes

- 2c438c3: Make queue() call backwardscompatible with zod v3 for codebases that pin zod
  - @workflow/errors@4.0.1-beta.6

## 4.0.1-beta.10

### Patch Changes

- 3d99d6d: Update `@vercel/oidc` and `@vercel/queue` to fix expired OIDC token edge case

## 4.0.1-beta.9

### Patch Changes

- 4b70739: Require specifying runId when writing to stream
- Updated dependencies [4b70739]
  - @workflow/world@4.0.1-beta.6
  - @workflow/errors@4.0.1-beta.5

## 4.0.1-beta.8

### Patch Changes

- b97b6bf: Lock all dependencies in our packages
- 00b0bb9: Support structured errors for steps and runs
- Updated dependencies [b97b6bf]
- Updated dependencies [00b0bb9]
- Updated dependencies [00b0bb9]
  - @workflow/errors@4.0.1-beta.5
  - @workflow/world@4.0.1-beta.5

## 4.0.1-beta.7

### Patch Changes

- 2dca0d4: Add custom user agent

## 4.0.1-beta.6

### Patch Changes

- @workflow/errors@4.0.1-beta.4

## 4.0.1-beta.5

### Patch Changes

- f973954: Update license to Apache 2.0
- Updated dependencies [f973954]
  - @workflow/errors@4.0.1-beta.3
  - @workflow/world@4.0.1-beta.4

## 4.0.1-beta.4

### Patch Changes

- 20d51f0: Enforce the Vercel Queue max visibility limit
- Updated dependencies [796fafd]
- Updated dependencies [20d51f0]
- Updated dependencies [70be894]
  - @workflow/errors@4.0.1-beta.2
  - @workflow/world@4.0.1-beta.3

## 4.0.1-beta.3

### Patch Changes

- e367046: Allow setting baseUrl and token for queue service

## 4.0.1-beta.2

### Patch Changes

- 7868434: Remove `AuthProvider` interface from `World` and associated implementations
- Updated dependencies [d3a4ed3]
- Updated dependencies [d3a4ed3]
- Updated dependencies [7868434]
  - @workflow/world@4.0.1-beta.2

## 4.0.1-beta.1

### Patch Changes

- 1408293: Add "description" field to `package.json` file
- e46294f: Add "license" and "repository" fields to `package.json` file
- Updated dependencies [1408293]
- Updated dependencies [8422a32]
- Updated dependencies [e46294f]
  - @workflow/errors@4.0.1-beta.1
  - @workflow/world@4.0.1-beta.1

## 4.0.1-beta.0

### Patch Changes

- fcf63d0: Initial publish
- Updated dependencies [fcf63d0]
  - @workflow/errors@4.0.1-beta.0
  - @workflow/world@4.0.1-beta.0
