# @workflow/core

## 4.0.1-beta.20

### Patch Changes

- 0f1645b: Ignore rejections in `waitedUntil` promise
- bdde1bd: track queue overhead with opentelemetry
- 8d4562e: Rename leftover references to "embedded world" to be "local world"
- Updated dependencies [bc9b628]
- Updated dependencies [34f3f86]
- Updated dependencies [cd451e0]
- Updated dependencies [6e8e828]
- Updated dependencies [10c5b91]
- Updated dependencies [bdde1bd]
- Updated dependencies [2faddf3]
- Updated dependencies [8d4562e]
  - @workflow/utils@4.0.1-beta.5
  - @workflow/world-local@4.0.1-beta.14
  - @workflow/world@4.0.1-beta.8
  - @workflow/errors@4.0.1-beta.7
  - @workflow/world-vercel@4.0.1-beta.14

## 4.0.1-beta.19

### Patch Changes

- 07800c2: Support closure variables for serialized step functions
- fb9fd0f: Add support for closure scope vars in step functions
- Updated dependencies [fb9fd0f]
- Updated dependencies [40057db]
  - @workflow/world@4.0.1-beta.7
  - @workflow/world-local@4.0.1-beta.13
  - @workflow/errors@4.0.1-beta.6
  - @workflow/world-vercel@4.0.1-beta.13

## 4.0.1-beta.18

### Patch Changes

- Updated dependencies [6889dac]
  - @workflow/world-vercel@4.0.1-beta.12

## 4.0.1-beta.17

### Patch Changes

- Updated dependencies [2c438c3]
- Updated dependencies [edb69c3]
  - @workflow/world-vercel@4.0.1-beta.11
  - @workflow/world-local@4.0.1-beta.12
  - @workflow/utils@4.0.1-beta.4
  - @workflow/errors@4.0.1-beta.6

## 4.0.1-beta.16

### Patch Changes

- 3436629: Fix bugs in streamer (empty chunk handling and cloning chunks)
- 9961140: Fix hydration of eventData for sleep calls
- 73b6c68: Remove suppressUndefinedRejection from BaseBuilder
- Updated dependencies [3436629]
  - @workflow/world-local@4.0.1-beta.11

## 4.0.1-beta.15

### Patch Changes

- 3d99d6d: Update `@vercel/oidc` and `@vercel/queue` to fix expired OIDC token edge case
- Updated dependencies [3d99d6d]
  - @workflow/world-vercel@4.0.1-beta.10
  - @workflow/world-local@5.0.0-beta.10

## 4.0.1-beta.14

### Patch Changes

- 6e41c90: Allow step retrying if it fails without proper cleanup

## 4.0.1-beta.13

### Patch Changes

- 2fde24e: Use inline sourcemaps to prevent SWC read import error
- 4b70739: Require specifying runId when writing to stream
- Updated dependencies [4b70739]
  - @workflow/world-vercel@4.0.1-beta.9
  - @workflow/world-local@5.0.0-beta.9
  - @workflow/world@4.0.1-beta.6
  - @workflow/errors@4.0.1-beta.5

## 4.0.1-beta.12

### Patch Changes

- 5eb588a: Remove step function identifier transform out of swc-plugin and into `useStep()` runtime function
- 00b0bb9: Implement the world's structured error interface
- 85ce8e0: add waitUntil wrapping for toplevel commands for transaction-like behavior

  when deployed on Vercel or other serverless providers, we must signal that we need to wait until operations are done before the function can halt the request.

  This means that we can't rely on discrete operations (like Queue.queue or Storage calls), and instead wrap the entire `start` function (which calls multiple discrete operations) in a single `await waitUntil` call.

- b97b6bf: Lock all dependencies in our packages
- f8e5d10: Support serializing step function references
- 6be03f3: Use "stepId" instead of `Symbol.for("STEP_FUNCTION_NAME_SYMBOL")` for annotating step functions
- f07b2da: Transform step functions to single `useStep()` calls
- Updated dependencies [aa015af]
- Updated dependencies [00b0bb9]
- Updated dependencies [b97b6bf]
- Updated dependencies [00b0bb9]
- Updated dependencies [00b0bb9]
- Updated dependencies [00b0bb9]
- Updated dependencies [79480f2]
  - @workflow/world-local@5.0.0-beta.8
  - @workflow/world-vercel@4.0.1-beta.8
  - @workflow/errors@4.0.1-beta.5
  - @workflow/utils@4.0.1-beta.3
  - @workflow/world@4.0.1-beta.5

## 4.0.1-beta.11

### Patch Changes

- 8208b53: Fix sourcemap error tracing in workflows
- aac1b6c: Make process.env in workflow context a readonly clone
- 6373ab5: BREAKING: `resumeHook()` now throws errors (including when a Hook is not found for a given "token") instead of returning `null`
- Updated dependencies [2b880f9]
- Updated dependencies [2dca0d4]
- Updated dependencies [68363b2]
  - @workflow/world-local@4.0.1-beta.7
  - @workflow/world-vercel@4.0.1-beta.7

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
