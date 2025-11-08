# @workflow/core

## 4.0.1-beta.10

### Patch Changes

- 7013f29: **BREAKING**: Change `RetryableError` "retryAfter" option number value to represent milliseconds instead of seconds. Previously, numeric values were interpreted as seconds; now they are interpreted as milliseconds. This aligns with JavaScript conventions for durations (like `setTimeout` and `setInterval`).
- a28bc37: Make `@standard-schema/spec` be a regular dependency
- 809e0fe: Add support for specifying milliseconds in `sleep()`
- adf0cfe: Add automatic port discovery
- 5c0268b: Add Standard Schema support and runtime validation to `defineHook()`
- 0b3e89e: Fix event data serialization for observability
- 7a47eb8: Deprecate deploymentId in StartOptions with warning that it should not be set by users
- Updated dependencies [bf170ad]
- Updated dependencies [adf0cfe]
  - @workflow/utils@4.0.1-beta.2
  - @workflow/world-local@4.0.1-beta.6
  - @workflow/errors@4.0.1-beta.4
  - @workflow/world-vercel@4.0.1-beta.6

## 4.0.1-beta.9

### Patch Changes

- 9f56434: Add support for getWritable directly in step functions

## 4.0.1-beta.8

### Patch Changes

- 4a821fc: Fix Windows path handling by normalizing backslashes to forward slashes in workflow IDs

## 4.0.1-beta.7

### Patch Changes

- 05714f7: Add sveltekit workflow integration
- Updated dependencies [05714f7]
  - @workflow/world-local@4.0.1-beta.5

## 4.0.1-beta.6

### Patch Changes

- 10309c3: Downgrade `@types/node` to v22.19.0
- f973954: Update license to Apache 2.0
- Updated dependencies [10309c3]
- Updated dependencies [f973954]
  - @workflow/world-local@4.0.1-beta.4
  - @workflow/world-vercel@4.0.1-beta.5
  - @workflow/errors@4.0.1-beta.3
  - @workflow/world@4.0.1-beta.4

## 4.0.1-beta.5

### Patch Changes

- 796fafd: Remove `isInstanceOf()` function and utilize `is()` method on Error subclasses instead
- 70be894: Implement `sleep()` natively into the workflow runtime
- 20d51f0: Respect the `retryAfter` property in the step function callback handler
- Updated dependencies [20d51f0]
- Updated dependencies [796fafd]
- Updated dependencies [20d51f0]
- Updated dependencies [20d51f0]
- Updated dependencies [70be894]
  - @workflow/world-vercel@4.0.1-beta.4
  - @workflow/errors@4.0.1-beta.2
  - @workflow/world-local@4.0.1-beta.3
  - @workflow/world@4.0.1-beta.3

## 4.0.1-beta.4

### Patch Changes

- 6504e42: Add support for bigint serialization
- Updated dependencies [e367046]
  - @workflow/world-vercel@4.0.1-beta.3

## 4.0.1-beta.3

### Patch Changes

- 57419e5: Improve type-safety to `start` when no args are provided
- Updated dependencies [d3a4ed3]
- Updated dependencies [d3a4ed3]
- Updated dependencies [66225bf]
- Updated dependencies [7868434]
  - @workflow/world@4.0.1-beta.2
  - @workflow/world-local@4.0.1-beta.2
  - @workflow/world-vercel@4.0.1-beta.2

## 4.0.1-beta.2

### Patch Changes

- 854feb4: Handle multiple step_started events in event log
- f1c6bc5: Throw an error when the event log is corrupted

## 4.0.1-beta.1

### Patch Changes

- 57ebfcb: Fix seedrandom not being listed in dependencies
- 1408293: Add "description" field to `package.json` file
- e46294f: Add "license" and "repository" fields to `package.json` file
- Updated dependencies [1408293]
- Updated dependencies [8422a32]
- Updated dependencies [e46294f]
  - @workflow/world-vercel@4.0.1-beta.1
  - @workflow/world-local@4.0.1-beta.1
  - @workflow/errors@4.0.1-beta.1
  - @workflow/world@4.0.1-beta.1

## 4.0.1-beta.0

### Patch Changes

- fcf63d0: Initial publish
- Updated dependencies [fcf63d0]
  - @workflow/world-vercel@4.0.1-beta.0
  - @workflow/world-local@4.0.1-beta.0
  - @workflow/errors@4.0.1-beta.0
  - @workflow/world@4.0.1-beta.0
