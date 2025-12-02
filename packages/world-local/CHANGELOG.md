# @workflow/world-local

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
