# @workflow/core

## 4.0.1-beta.36

### Patch Changes

- Updated dependencies [[`dd3db13`](https://github.com/vercel/workflow/commit/dd3db13d5498622284ed97c1a273d2942478b167)]:
  - @workflow/world@4.0.1-beta.12
  - @workflow/world-local@4.0.1-beta.25
  - @workflow/world-vercel@4.0.1-beta.26
  - @workflow/errors@4.0.1-beta.13

## 4.0.1-beta.35

### Patch Changes

- [#720](https://github.com/vercel/workflow/pull/720) [`4d6f797`](https://github.com/vercel/workflow/commit/4d6f797274331b2efa69576dda7361ef7f704edf) Thanks [@pranaygp](https://github.com/pranaygp)! - Correctly propagate stack traces for step errors

## 4.0.1-beta.34

### Patch Changes

- [#703](https://github.com/vercel/workflow/pull/703) [`9b1640d`](https://github.com/vercel/workflow/commit/9b1640d76e7e759446058d65272011071bb250d2) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Do not include initial attempt in step function `maxRetries` count

- [#712](https://github.com/vercel/workflow/pull/712) [`307f4b0`](https://github.com/vercel/workflow/commit/307f4b0e41277f6b32afbfa361d8c6ca1b3d7f6c) Thanks [@ijjk](https://github.com/ijjk)! - Revert lazy workflow and step discovery

- Updated dependencies [[`9b1640d`](https://github.com/vercel/workflow/commit/9b1640d76e7e759446058d65272011071bb250d2)]:
  - @workflow/utils@4.0.1-beta.10
  - @workflow/errors@4.0.1-beta.13
  - @workflow/world-local@4.0.1-beta.24
  - @workflow/world-vercel@4.0.1-beta.25

## 4.0.1-beta.33

### Patch Changes

- Updated dependencies [[`2dbe494`](https://github.com/vercel/workflow/commit/2dbe49495dd4fae22edc53e190952c8f15289b8b)]:
  - @workflow/world-local@4.0.1-beta.23

## 4.0.1-beta.32

### Patch Changes

- [#455](https://github.com/vercel/workflow/pull/455) [`e3f0390`](https://github.com/vercel/workflow/commit/e3f0390469b15f54dee7aa9faf753cb7847a60c6) Thanks [@karthikscale3](https://github.com/karthikscale3)! - Added Control Flow Graph extraction from Workflows and extended manifest.json's schema to incorporate the graph structure into it. Refactored manifest generation to pass manifest as a parameter instead of using instance state. Add e2e tests for manifest validation across all builders.

- Updated dependencies [[`e3f0390`](https://github.com/vercel/workflow/commit/e3f0390469b15f54dee7aa9faf753cb7847a60c6)]:
  - @workflow/world-local@4.0.1-beta.22
  - @workflow/utils@4.0.1-beta.9
  - @workflow/world@4.0.1-beta.11
  - @workflow/errors@4.0.1-beta.12
  - @workflow/world-vercel@4.0.1-beta.24

## 4.0.1-beta.31

### Patch Changes

- [#624](https://github.com/vercel/workflow/pull/624) [`25b02b0`](https://github.com/vercel/workflow/commit/25b02b0bfdefa499e13fb974b1832fbe47dbde86) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Add CORS headers to endpoints health check response

- Updated dependencies [[`d9f6a49`](https://github.com/vercel/workflow/commit/d9f6a4939760be94dfc9eaf77dcaa48c602c18ef), [`0cf0ac3`](https://github.com/vercel/workflow/commit/0cf0ac32114bcdfa49319d27c2ce98da516690f1), [`c3464bf`](https://github.com/vercel/workflow/commit/c3464bfd978a073f6d8fca95208bd053aa5c78dd)]:
  - @workflow/world-local@4.0.1-beta.21
  - @workflow/utils@4.0.1-beta.8
  - @workflow/errors@4.0.1-beta.11
  - @workflow/world-vercel@4.0.1-beta.23

## 4.0.1-beta.30

### Patch Changes

- Updated dependencies [[`f2d5997`](https://github.com/vercel/workflow/commit/f2d5997b800d6c474bb93d4ddd82cf52489752da)]:
  - @workflow/world-local@4.0.1-beta.20

## 4.0.1-beta.29

### Patch Changes

- [#649](https://github.com/vercel/workflow/pull/649) [`eaf9aa6`](https://github.com/vercel/workflow/commit/eaf9aa65f354bf1e22e8e148c0fd1936f0ec9358) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Don't shadow `globalThis`

- Updated dependencies [[`75a5060`](https://github.com/vercel/workflow/commit/75a506047304f6dd1ac07d9150e8a9563f69283c), [`6cd1a47`](https://github.com/vercel/workflow/commit/6cd1a47b3146770f5cb9d4c384971331aab6b28a)]:
  - @workflow/world-vercel@4.0.1-beta.22

## 4.0.1-beta.28

### Patch Changes

- [#544](https://github.com/vercel/workflow/pull/544) [`ea2a67e`](https://github.com/vercel/workflow/commit/ea2a67e19c5d224b4b4fd1c1a417810562df0807) Thanks [@pranaygp](https://github.com/pranaygp)! - perf: parallelize suspension handler and refactor runtime

  - Process hooks first, then steps and waits in parallel to prevent race conditions
  - Refactor runtime.ts into modular files: `suspension-handler.ts`, `step-handler.ts`, `helpers.ts`
  - Add otel attributes for hooks created (`workflow.hooks.created`) and waits created (`workflow.waits.created`)
  - Update suspension status from `pending_steps` to `workflow_suspended`

- [#625](https://github.com/vercel/workflow/pull/625) [`712f6f8`](https://github.com/vercel/workflow/commit/712f6f86b1804c82d4cab3bba0db49584451d005) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Change serialized stream names from v4 UUIDs to ULIDs

- Updated dependencies [[`ce7d428`](https://github.com/vercel/workflow/commit/ce7d428a07cd415d2ea64c779b84ecdc796927a0), [`712f6f8`](https://github.com/vercel/workflow/commit/712f6f86b1804c82d4cab3bba0db49584451d005), [`ab55ba2`](https://github.com/vercel/workflow/commit/ab55ba2d61b41e2b2cd9e213069c93be988c9b1e), [`4bdd3e5`](https://github.com/vercel/workflow/commit/4bdd3e5086a51a46898cca774533019d3ace77b3)]:
  - @workflow/world-local@4.0.1-beta.19
  - @workflow/world-vercel@4.0.1-beta.21
  - @workflow/errors@4.0.1-beta.10

## 4.0.1-beta.27

### Patch Changes

- [#627](https://github.com/vercel/workflow/pull/627) [`deaf019`](https://github.com/vercel/workflow/commit/deaf0193e91ea7a24d2423a813b64f51faa681e3) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - [world-vercel] Allow skipping vercel backend proxy for e2e tests where CLI runs in runtime env

- [#505](https://github.com/vercel/workflow/pull/505) [`b56aae3`](https://github.com/vercel/workflow/commit/b56aae3fe9b5568d7bdda592ed025b3499149240) Thanks [@copilot-swe-agent](https://github.com/apps/copilot-swe-agent)! - Override setTimeout, setInterval, and related functions in workflow VM context to throw helpful errors suggesting to use `sleep` instead

- [#613](https://github.com/vercel/workflow/pull/613) [`4d7a393`](https://github.com/vercel/workflow/commit/4d7a393906846be751e798c943594bec3c9b0ff3) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add workflow endpoints health check query parameter

- Updated dependencies [[`1ef6b2f`](https://github.com/vercel/workflow/commit/1ef6b2fdc8dc7e4d665aa2fe1a7d9e68ce7f1e95), [`deaf019`](https://github.com/vercel/workflow/commit/deaf0193e91ea7a24d2423a813b64f51faa681e3), [`b56aae3`](https://github.com/vercel/workflow/commit/b56aae3fe9b5568d7bdda592ed025b3499149240)]:
  - @workflow/utils@4.0.1-beta.7
  - @workflow/world-vercel@4.0.1-beta.20
  - @workflow/errors@4.0.1-beta.9
  - @workflow/world-local@4.0.1-beta.18

## 4.0.1-beta.26

### Patch Changes

- [#588](https://github.com/vercel/workflow/pull/588) [`696e7e3`](https://github.com/vercel/workflow/commit/696e7e31e88eae5d86e9d4b9f0344f0777ae9673) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Fix rare case where workflows get stuck due to edge case in step update logic

- Updated dependencies [[`c9b8d84`](https://github.com/vercel/workflow/commit/c9b8d843fd0a88de268d603a14ebe2e7c726169a)]:
  - @workflow/world-local@4.0.1-beta.17
  - @workflow/utils@4.0.1-beta.6
  - @workflow/errors@4.0.1-beta.8
  - @workflow/world-vercel@4.0.1-beta.19

## 4.0.1-beta.25

### Patch Changes

- [#575](https://github.com/vercel/workflow/pull/575) [`161c54c`](https://github.com/vercel/workflow/commit/161c54ca13e0c36220640e656b7abe4ff282dbb0) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Add Web and CLI UI for listing and viewing streams

- [#541](https://github.com/vercel/workflow/pull/541) [`0bbd26f`](https://github.com/vercel/workflow/commit/0bbd26f8c85a04dea3dc87a11c52e9ac63a18e84) Thanks [@pranaygp](https://github.com/pranaygp)! - perf: use Map for invocationsQueue (O(1) lookup/delete)

  Replace array-based invocationsQueue with Map for O(1) lookup and delete operations, eliminating O(n²) complexity in high-concurrency workflows.

- [#567](https://github.com/vercel/workflow/pull/567) [`c35b445`](https://github.com/vercel/workflow/commit/c35b4458753cc116b90d61f470f7ab1d964e8a1e) Thanks [@Schniz](https://github.com/Schniz)! - otel: do not treat WorkflowSuspension errors as errors in the trace, as they symbolize effects and not actual exceptions.

- [#571](https://github.com/vercel/workflow/pull/571) [`d3fd81d`](https://github.com/vercel/workflow/commit/d3fd81dffd87abbd1a3d8a8e91e9781959eefd40) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Enhance serialization failure error reporting

- Updated dependencies [[`d42a968`](https://github.com/vercel/workflow/commit/d42a9681a1c7139ac5ed2973b1738d8a9000a1b6), [`c82b467`](https://github.com/vercel/workflow/commit/c82b46720cf6284f3c7e3ded107e1d8321f6e705)]:
  - @workflow/world-local@4.0.1-beta.16
  - @workflow/world-vercel@4.0.1-beta.18
  - @workflow/world@4.0.1-beta.10
  - @workflow/errors@4.0.1-beta.7

## 4.0.1-beta.24

### Patch Changes

- Updated dependencies [48b3a12]
- Updated dependencies [57a2c32]
  - @workflow/world-local@4.0.1-beta.15
  - @workflow/world@4.0.1-beta.9
  - @workflow/errors@4.0.1-beta.7
  - @workflow/world-vercel@4.0.1-beta.17

## 4.0.1-beta.23

### Patch Changes

- Updated dependencies [c8fa70a]
  - @workflow/world-vercel@4.0.1-beta.16

## 4.0.1-beta.22

### Patch Changes

- 02c41cc: Set UI name of default-export-workflows to the filename, instead of "\_\_default"

## 4.0.1-beta.21

### Patch Changes

- 2f0840b: Better error when passing an invalid workflow value to `start()`
- Updated dependencies [e9494d5]
  - @workflow/world-vercel@4.0.1-beta.15

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
