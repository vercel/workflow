# @workflow/world-local

## 5.0.0-beta.2

### Patch Changes

- [#1769](https://github.com/vercel/workflow/pull/1769) [`5a42964`](https://github.com/vercel/workflow/commit/5a4296412f151c255a8d08c8870e511222c7c472) Thanks [@tomdale](https://github.com/tomdale)! - Embed source content in published sourcemaps.

- [#1739](https://github.com/vercel/workflow/pull/1739) [`11cfb8f`](https://github.com/vercel/workflow/commit/11cfb8f3fb4c64bde92cf51a5990a7773c263f94) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Add filesystem polling to enable cross-process streaming in local development

- Updated dependencies [[`5a42964`](https://github.com/vercel/workflow/commit/5a4296412f151c255a8d08c8870e511222c7c472), [`173756d`](https://github.com/vercel/workflow/commit/173756dc4d097fd90432e2c38c91ce1b959a6352)]:
  - @workflow/errors@5.0.0-beta.1
  - @workflow/utils@5.0.0-beta.1

## 5.0.0-beta.1

### Major Changes

- [#1293](https://github.com/vercel/workflow/pull/1293) [`66d49c0`](https://github.com/vercel/workflow/commit/66d49c0db608b034c8fc1b4087a047e0be067b77) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - **BREAKING CHANGE**: Restructure stream methods on World interface to use `world.streams.*` namespace with `runId` as the first parameter. `writeToStream(name, runId, chunk)` → `streams.write(runId, name, chunk)`, `writeToStreamMulti` → `streams.writeMulti`, `closeStream` → `streams.close`, `readFromStream` → `streams.get(runId, name, startIndex?)`, `listStreamsByRunId` → `streams.list(runId)`.

- [#1293](https://github.com/vercel/workflow/pull/1293) [`66d49c0`](https://github.com/vercel/workflow/commit/66d49c0db608b034c8fc1b4087a047e0be067b77) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Require `runId` argument for `world.steps.get`.

### Patch Changes

- [#1658](https://github.com/vercel/workflow/pull/1658) [`a5c90ce`](https://github.com/vercel/workflow/commit/a5c90cefba01070aa4bc12a696334ee4c1061f92) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Fix community world E2E tests by adding `specVersion` to the World interface so `start()` uses the safe baseline (v2) for worlds that don't declare their supported version

- Updated dependencies [[`66d49c0`](https://github.com/vercel/workflow/commit/66d49c0db608b034c8fc1b4087a047e0be067b77), [`a5c90ce`](https://github.com/vercel/workflow/commit/a5c90cefba01070aa4bc12a696334ee4c1061f92), [`66d49c0`](https://github.com/vercel/workflow/commit/66d49c0db608b034c8fc1b4087a047e0be067b77)]:
  - @workflow/world@5.0.0-beta.1
  - @workflow/errors@5.0.0-beta.0

## 5.0.0-beta.0

### Major Changes

- [#1642](https://github.com/vercel/workflow/pull/1642) [`c5cdfc0`](https://github.com/vercel/workflow/commit/c5cdfc00751c5bef36c4be748d819081b934fbcd) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Initial v5 beta release

### Patch Changes

- Updated dependencies [[`c5cdfc0`](https://github.com/vercel/workflow/commit/c5cdfc00751c5bef36c4be748d819081b934fbcd)]:
  - @workflow/errors@5.0.0-beta.0
  - @workflow/utils@5.0.0-beta.0
  - @workflow/world@5.0.0-beta.0

## 4.1.0-beta.51

### Patch Changes

- [#1533](https://github.com/vercel/workflow/pull/1533) [`7e70d18`](https://github.com/vercel/workflow/commit/7e70d1823add7930d6df7f84e1a6a77d888eb851) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Add `streamFlushIntervalMs` option to `Streamer` interface, optional for worlds to allow overwriting the default of 10ms in low-latency environments.

- [#1537](https://github.com/vercel/workflow/pull/1537) [`c8dce52`](https://github.com/vercel/workflow/commit/c8dce5260627a2f349618976e8478ce03e656536) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Allow workflow invocation to create run if initial storage call in `start` did not succeed. Send run input through queue to enable this. Allow creating run_created and run_started events together in World, and skip first event list call by returning events directly.

- Updated dependencies [[`5f138f2`](https://github.com/vercel/workflow/commit/5f138f2ceedcc96c9d043fa36378c4de781ab55b), [`7e70d18`](https://github.com/vercel/workflow/commit/7e70d1823add7930d6df7f84e1a6a77d888eb851), [`c8dce52`](https://github.com/vercel/workflow/commit/c8dce5260627a2f349618976e8478ce03e656536)]:
  - @workflow/world@4.1.0-beta.17
  - @workflow/errors@4.1.0-beta.20

## 4.1.0-beta.50

### Patch Changes

- [#1605](https://github.com/vercel/workflow/pull/1605) [`b30b0dc`](https://github.com/vercel/workflow/commit/b30b0dcab68a8cc37735ea6c1fb8cb4f06efbe8b) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Use asymmetric ULID timestamp validation thresholds: 24h past, 5min future.

- Updated dependencies [[`b30b0dc`](https://github.com/vercel/workflow/commit/b30b0dcab68a8cc37735ea6c1fb8cb4f06efbe8b)]:
  - @workflow/world@4.1.0-beta.16
  - @workflow/errors@4.1.0-beta.20

## 4.1.0-beta.49

### Patch Changes

- [#1588](https://github.com/vercel/workflow/pull/1588) [`ef2218a`](https://github.com/vercel/workflow/commit/ef2218ab22310afa04e4e1709906a86969126e52) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Fix zod v3/v4 schema mismatch crash (`keyValidator._parse is not a function`) by using consistent `zod/v4` imports in queue files that consume v4-native schemas from `@workflow/world`

## 4.1.0-beta.48

### Patch Changes

- [#1569](https://github.com/vercel/workflow/pull/1569) [`a98f8de`](https://github.com/vercel/workflow/commit/a98f8de53f1af222cccea6d091b68d544957b4e3) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Combine initial run fetch, event fetch, and run_started event creation

- [#1534](https://github.com/vercel/workflow/pull/1534) [`329cdb3`](https://github.com/vercel/workflow/commit/329cdb3e1b55e3a2e8eb6b5befff598d7184bd78) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Re-enqueue active runs on world restart so inflight runs resume instead of getting stuck

- Updated dependencies [[`a98f8de`](https://github.com/vercel/workflow/commit/a98f8de53f1af222cccea6d091b68d544957b4e3), [`6dc1b78`](https://github.com/vercel/workflow/commit/6dc1b785822af5c1dc3b4a2a9b1dcb7f626cf5ff), [`329cdb3`](https://github.com/vercel/workflow/commit/329cdb3e1b55e3a2e8eb6b5befff598d7184bd78)]:
  - @workflow/world@4.1.0-beta.15
  - @workflow/errors@4.1.0-beta.20

## 4.1.0-beta.47

### Patch Changes

- [#1494](https://github.com/vercel/workflow/pull/1494) [`bd1f7e4`](https://github.com/vercel/workflow/commit/bd1f7e4b4c45750f9b8a3f37057076f2e69a5c07) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Tidy code for stream chunk listing and metadata

## 4.1.0-beta.46

### Patch Changes

- [#1523](https://github.com/vercel/workflow/pull/1523) [`d1391e1`](https://github.com/vercel/workflow/commit/d1391e1fd9a553d87ae467ba2babdc96545d5d36) Thanks [@pranaygp](https://github.com/pranaygp)! - Fix race condition allowing duplicate `hook_disposed` events for the same hook

## 4.1.0-beta.45

### Patch Changes

- [#1340](https://github.com/vercel/workflow/pull/1340) [`84599b7`](https://github.com/vercel/workflow/commit/84599b7ec5c19207082523609f1b3508a1a18bd7) Thanks [@pranaygp](https://github.com/pranaygp)! - Add error code classification (`USER_ERROR`, `RUNTIME_ERROR`) to `run_failed` events, improve queue and schema validation error logging

- [#1434](https://github.com/vercel/workflow/pull/1434) [`d428d66`](https://github.com/vercel/workflow/commit/d428d66441319e612b72f9b7cf430abcf45a5ecf) Thanks [@pranaygp](https://github.com/pranaygp)! - Add atomic terminal-state guards to step and wait transitions using `writeExclusive` lock files. Prevents concurrent `step_completed`/`step_failed`/`wait_completed` races and blocks `step_started` on already-terminal steps. Also adds `cancelled` to `isStepTerminal`.

- [#1344](https://github.com/vercel/workflow/pull/1344) [`beccbc4`](https://github.com/vercel/workflow/commit/beccbc4298f434a4ffb9563c4f832f2230016f40) Thanks [@pranaygp](https://github.com/pranaygp)! - Remove VQS maxDeliveries cap and enforce max delivery limit in workflow/step handlers with graceful failure

- [#1460](https://github.com/vercel/workflow/pull/1460) [`78f1b0e`](https://github.com/vercel/workflow/commit/78f1b0e19f2ac1a621020bc9fa5dec778f3b0fd9) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Support negative `startIndex` for streaming (e.g. `-3` reads last 3 chunks)

- [#1342](https://github.com/vercel/workflow/pull/1342) [`aee035f`](https://github.com/vercel/workflow/commit/aee035f94483ef3b842bb557e8c5b167dd0536c4) Thanks [@pranaygp](https://github.com/pranaygp)! - Replace HTTP status code checks with semantic error types (EntityConflictError, RunExpiredError, ThrottleError, TooEarlyError). **BREAKING CHANGE**: `WorkflowAPIError` renamed to `WorkflowWorldError`.

- [#1470](https://github.com/vercel/workflow/pull/1470) [`01bbe66`](https://github.com/vercel/workflow/commit/01bbe66d5a60d50d71f5b1c82b002ca7fc6f8e0b) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Add `getStreamChunks()` and `getStreamInfo()` to the Streamer interface, and `getTailIndex()` to the readable stream returned by `run.getReadable()`. `WorkflowChatTransport` now reads the `x-workflow-stream-tail-index` response header to resolve negative `initialStartIndex` values into absolute positions, fixing reconnection retries after a disconnect.

- Updated dependencies [[`73a851a`](https://github.com/vercel/workflow/commit/73a851ada6a4d46ae8f022ef243ebf4ee3de2ad8), [`84599b7`](https://github.com/vercel/workflow/commit/84599b7ec5c19207082523609f1b3508a1a18bd7), [`2ef33d2`](https://github.com/vercel/workflow/commit/2ef33d2828ac06debf04ad9cc239d70fea6a8093), [`672d919`](https://github.com/vercel/workflow/commit/672d9195a475a110a64dbaa7c5c87a24f244c11a), [`beccbc4`](https://github.com/vercel/workflow/commit/beccbc4298f434a4ffb9563c4f832f2230016f40), [`78f1b0e`](https://github.com/vercel/workflow/commit/78f1b0e19f2ac1a621020bc9fa5dec778f3b0fd9), [`aee035f`](https://github.com/vercel/workflow/commit/aee035f94483ef3b842bb557e8c5b167dd0536c4), [`01bbe66`](https://github.com/vercel/workflow/commit/01bbe66d5a60d50d71f5b1c82b002ca7fc6f8e0b)]:
  - @workflow/errors@4.1.0-beta.19
  - @workflow/world@4.1.0-beta.14

## 4.1.0-beta.44

### Patch Changes

- [#1417](https://github.com/vercel/workflow/pull/1417) [`02ea057`](https://github.com/vercel/workflow/commit/02ea0574422b342e6a467de073e003b73e099830) Thanks [@NathanColosimo](https://github.com/NathanColosimo)! - Remove the unused world-local queue executor API and clean up postgres queue tests.

- [#1359](https://github.com/vercel/workflow/pull/1359) [`0f07403`](https://github.com/vercel/workflow/commit/0f074030a408078e7db0ae0e494f64125d7444e4) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Write workflow data for vitest to the same folder as other local world runs, allowing them to be visible in observability tooling. Use a suffix-based system to ensure clearing runs on test start only affects vitest-related data.

- [#1364](https://github.com/vercel/workflow/pull/1364) [`94c14c7`](https://github.com/vercel/workflow/commit/94c14c746b3218d13a5e2a7936c8cef505e7be08) Thanks [@karthikscale3](https://github.com/karthikscale3)! - Strip only ref/payload fields from eventData when resolveData is 'none', preserving all other metadata

- Updated dependencies [[`2f0772d`](https://github.com/vercel/workflow/commit/2f0772d3df4983de2f6618054379a496ade4ec5a), [`94c14c7`](https://github.com/vercel/workflow/commit/94c14c746b3218d13a5e2a7936c8cef505e7be08)]:
  - @workflow/world@4.1.0-beta.13
  - @workflow/errors@4.1.0-beta.18

## 4.1.0-beta.43

### Patch Changes

- [#1348](https://github.com/vercel/workflow/pull/1348) [`9feebee`](https://github.com/vercel/workflow/commit/9feebee15c7c35843b99254b23a2f7743ea3f8c6) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Ensure atomicity for hook token, matches world-postgres and world-vercel

## 4.1.0-beta.42

### Patch Changes

- [#1334](https://github.com/vercel/workflow/pull/1334) [`3648109`](https://github.com/vercel/workflow/commit/3648109861f1fbfe24101936dc35c9a36650b7e2) Thanks [@NathanColosimo](https://github.com/NathanColosimo)! - Refactor queue handler to separate queue behavior from route call behavior and export QueueExecutor.

- Updated dependencies [[`825417a`](https://github.com/vercel/workflow/commit/825417acbaf7f721259427ecf4b7bc2a0e5cbef7)]:
  - @workflow/world@4.1.0-beta.12
  - @workflow/errors@4.1.0-beta.18

## 4.1.0-beta.41

### Patch Changes

- [#1307](https://github.com/vercel/workflow/pull/1307) [`4a6ddd8`](https://github.com/vercel/workflow/commit/4a6ddd82c0fc1b3768f3a10befad77f43e81036e) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Return HTTP 200 instead of 503 for queue timeout re-enqueue signals in local world

## 4.1.0-beta.40

### Patch Changes

- [#1287](https://github.com/vercel/workflow/pull/1287) [`d8daa2a`](https://github.com/vercel/workflow/commit/d8daa2a9a95e2d01a4e6fee4e8dde51d82db762d) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Add `world.events.get(runId, eventId)` to the Storage interface for fetching a single event by ID.

- Updated dependencies [[`d8daa2a`](https://github.com/vercel/workflow/commit/d8daa2a9a95e2d01a4e6fee4e8dde51d82db762d)]:
  - @workflow/world@4.1.0-beta.11
  - @workflow/errors@4.1.0-beta.18

## 4.1.0-beta.39

### Patch Changes

- [#1290](https://github.com/vercel/workflow/pull/1290) [`8b5a388`](https://github.com/vercel/workflow/commit/8b5a388a9451d7c7460481f0889da5037bd90893) Thanks [@pranaygp](https://github.com/pranaygp)! - Support `timeoutSeconds: 0` for immediate re-enqueue without arbitrary delay

## 4.1.0-beta.38

### Patch Changes

- [#1237](https://github.com/vercel/workflow/pull/1237) [`456c1aa`](https://github.com/vercel/workflow/commit/456c1aa455d9d391a954b25e3d86ee9b06ad2f30) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Add `registerHandler` function to allow getting direct callbacks for plugins using local world

- [#1273](https://github.com/vercel/workflow/pull/1273) [`11dcb64`](https://github.com/vercel/workflow/commit/11dcb646d33e7a2b251d9388c2c8ecdd6aca73f7) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Locally validate run ID to be ULID when passed by user

- Updated dependencies [[`11dcb64`](https://github.com/vercel/workflow/commit/11dcb646d33e7a2b251d9388c2c8ecdd6aca73f7)]:
  - @workflow/world@4.1.0-beta.10
  - @workflow/errors@4.1.0-beta.18

## 4.1.0-beta.37

### Patch Changes

- [#1270](https://github.com/vercel/workflow/pull/1270) [`adfe8b6`](https://github.com/vercel/workflow/commit/adfe8b6b1123ce581aa9572bae91b8d7f9cdc53d) Thanks [@pranaygp](https://github.com/pranaygp)! - Add `HookNotFoundError` to `@workflow/errors` and adopt it across all world backends

- [#1270](https://github.com/vercel/workflow/pull/1270) [`adfe8b6`](https://github.com/vercel/workflow/commit/adfe8b6b1123ce581aa9572bae91b8d7f9cdc53d) Thanks [@pranaygp](https://github.com/pranaygp)! - Prevent hooks from being resumed via the public webhook endpoint by default. Add `isWebhook` option to `createHook()` to opt-in to public resumption. `createWebhook()` always sets `isWebhook: true`.

- [#1275](https://github.com/vercel/workflow/pull/1275) [`02f706f`](https://github.com/vercel/workflow/commit/02f706fb99d2ffa3f862698092d17cedbdb8ba02) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Fix `hooks.list()` default sort order to ascending (creation order) in world-local and world-postgres, matching world-vercel behavior. Also fix world-postgres `hooks.list()` to respect the `sortOrder` pagination parameter instead of hardcoding descending order.

- Updated dependencies [[`adfe8b6`](https://github.com/vercel/workflow/commit/adfe8b6b1123ce581aa9572bae91b8d7f9cdc53d), [`adfe8b6`](https://github.com/vercel/workflow/commit/adfe8b6b1123ce581aa9572bae91b8d7f9cdc53d)]:
  - @workflow/errors@4.1.0-beta.18
  - @workflow/world@4.1.0-beta.9

## 4.1.0-beta.36

### Patch Changes

- [#1211](https://github.com/vercel/workflow/pull/1211) [`1cfb8b1`](https://github.com/vercel/workflow/commit/1cfb8b12e7d40e372d6e223add1518cd62fa0b5f) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Use undici v7 Agent for HTTP/2 multiplexing and automatic retry

- [#1217](https://github.com/vercel/workflow/pull/1217) [`e55c636`](https://github.com/vercel/workflow/commit/e55c63678b15b6687cc77efca705ee9fb40fabc3) Thanks [@pranaygp](https://github.com/pranaygp)! - Upgrade dependencies across all packages

- Updated dependencies [[`e55c636`](https://github.com/vercel/workflow/commit/e55c63678b15b6687cc77efca705ee9fb40fabc3)]:
  - @workflow/utils@4.1.0-beta.13
  - @workflow/world@4.1.0-beta.8
  - @workflow/errors@4.1.0-beta.17

## 4.1.0-beta.35

### Patch Changes

- Updated dependencies [[`b06e491`](https://github.com/vercel/workflow/commit/b06e491a4769724435afff66724ac9e275fe11df)]:
  - @workflow/world@4.1.0-beta.7
  - @workflow/errors@4.1.0-beta.16

## 4.1.0-beta.34

### Patch Changes

- Updated dependencies [[`b65bb07`](https://github.com/vercel/workflow/commit/b65bb072b540e9e5fb6bc3f72c4132667cc60277)]:
  - @workflow/world@4.1.0-beta.6
  - @workflow/errors@4.1.0-beta.16

## 4.1.0-beta.33

### Patch Changes

- [#1057](https://github.com/vercel/workflow/pull/1057) [`5e06a7c`](https://github.com/vercel/workflow/commit/5e06a7c8332042a4835fa0e469e1031fec742668) Thanks [@pranaygp](https://github.com/pranaygp)! - Materialize waits as entities to prevent duplicate wait_completed events
  - `@workflow/core`: Handle 409 conflict gracefully when creating wait_completed events, preventing crashes when multiple concurrent invocations race to complete the same wait
  - `@workflow/world`: Add `Wait` type, `WaitSchema`, and `WaitStatusSchema` exports; add optional `wait` field to `EventResult`
  - `@workflow/world-local`: Materialize wait entities on wait_created/wait_completed with duplicate detection; clean up waits on terminal run states
  - `@workflow/world-postgres`: Add `workflow_waits` table with `wait_status` enum; materialize wait entities with conditional writes for duplicate prevention; clean up waits on terminal run states

- [#1081](https://github.com/vercel/workflow/pull/1081) [`5487983`](https://github.com/vercel/workflow/commit/54879835f390299f9249523e0488bbdca708fb68) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Implement `World.close()` to close the undici HTTP agent; refactor agent from module-level singleton to instance-scoped

- Updated dependencies [[`c2b4fe9`](https://github.com/vercel/workflow/commit/c2b4fe9906fd0845fef646669034cd203d97a18d), [`6e72b29`](https://github.com/vercel/workflow/commit/6e72b295e71c1a9e0a91dbe1137eca7b88227e1f), [`5e06a7c`](https://github.com/vercel/workflow/commit/5e06a7c8332042a4835fa0e469e1031fec742668), [`5487983`](https://github.com/vercel/workflow/commit/54879835f390299f9249523e0488bbdca708fb68)]:
  - @workflow/errors@4.1.0-beta.16
  - @workflow/world@4.1.0-beta.5

## 4.1.0-beta.32

### Patch Changes

- [#1020](https://github.com/vercel/workflow/pull/1020) [`63caf93`](https://github.com/vercel/workflow/commit/63caf931380b8211f1948cf44eac7532f33e660d) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Stream chunk files now use .bin extension instead of .json. Backwards compatible with existing .json chunk files.

## 4.1.0-beta.31

### Patch Changes

- Updated dependencies [[`3d770d5`](https://github.com/vercel/workflow/commit/3d770d53855ce7c8522d4f0afbdbc123eae6c1ee), [`56f2221`](https://github.com/vercel/workflow/commit/56f22219b338a5a2c29466798a5ad36a6a450498)]:
  - @workflow/utils@4.1.0-beta.12
  - @workflow/errors@4.1.0-beta.15
  - @workflow/world@4.1.0-beta.4

## 4.1.0-beta.30

### Patch Changes

- Updated dependencies [[`d9e9859`](https://github.com/vercel/workflow/commit/d9e98590fae17fd090e0be4f0b54bbaa80c7be69)]:
  - @workflow/world@4.1.0-beta.3
  - @workflow/errors@4.1.0-beta.14

## 4.1.0-beta.29

### Patch Changes

- [#922](https://github.com/vercel/workflow/pull/922) [`0ce46b9`](https://github.com/vercel/workflow/commit/0ce46b91d9c8ca3349f43cdf3a5d75a948d6f5ad) Thanks [@pranaygp](https://github.com/pranaygp)! - Add support for custom headers in queue messages

- [#867](https://github.com/vercel/workflow/pull/867) [`c54ba21`](https://github.com/vercel/workflow/commit/c54ba21c19040577ed95f6264a2670f190e1d1d3) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add optional `writeToStreamMulti` function to the World interface

- [#932](https://github.com/vercel/workflow/pull/932) [`088de0a`](https://github.com/vercel/workflow/commit/088de0ae422bb7c958109d689127691cea5753b6) Thanks [@pranaygp](https://github.com/pranaygp)! - Improve OpenTelemetry tracing instrumentation
  - Add W3C trace context headers to step queue messages for cross-service trace linking
  - Add `peer.service` and RPC semantic conventions for external service attribution
  - Add `step.hydrate` and `step.dehydrate` spans for argument serialization visibility
  - Add `workflow.replay` span for workflow event replay tracking
  - Rename `queueMessage` span to `queue.publish` following OTEL messaging conventions
  - Add OTEL baggage propagation for workflow context (`workflow.run_id`, `workflow.name`)
  - Add span events for milestones: `retry.scheduled`, `step.skipped`, `step.delayed`
  - Enhance error telemetry with `recordException()` and error categorization (fatal/retryable/transient)
  - Use uppercase span names (WORKFLOW, STEP) for consistency with HTTP spans
  - Add world-local OTEL instrumentation matching world-vercel

- [#932](https://github.com/vercel/workflow/pull/932) [`088de0a`](https://github.com/vercel/workflow/commit/088de0ae422bb7c958109d689127691cea5753b6) Thanks [@pranaygp](https://github.com/pranaygp)! - Optimize step handler performance and improve server-side validation
  - Skip initial `world.steps.get()` call in step handler (saves one HTTP round-trip)
  - Add server-side `retryAfter` validation to local and postgres worlds (HTTP 425 when not reached)
  - Fix HTTP status code for step terminal state: return 409 (Conflict) instead of 410
  - Fix race condition: await `step_started` event before hydration to ensure correct attempt count

- Updated dependencies [[`0ce46b9`](https://github.com/vercel/workflow/commit/0ce46b91d9c8ca3349f43cdf3a5d75a948d6f5ad), [`c54ba21`](https://github.com/vercel/workflow/commit/c54ba21c19040577ed95f6264a2670f190e1d1d3)]:
  - @workflow/world@4.1.0-beta.2
  - @workflow/errors@4.1.0-beta.14

## 4.1.0-beta.28

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

- [#718](https://github.com/vercel/workflow/pull/718) [`57f6376`](https://github.com/vercel/workflow/commit/57f637653d3790b9a77b2cd072bcf02fa6b61d74) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Fix package info stored in data dir showing the wrong version

- [#903](https://github.com/vercel/workflow/pull/903) [`60a9b76`](https://github.com/vercel/workflow/commit/60a9b7661a86b6bd44c25cddf68cadf0515f195e) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Increase local world concurrency limits for HTTP and queue semaphore from 100 to 1000

- [#621](https://github.com/vercel/workflow/pull/621) [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae) Thanks [@pranaygp](https://github.com/pranaygp)! - Implement event-sourced entity creation in `events.create()`
  - Atomically create run/step/hook entities when processing corresponding events
  - Return `hook_conflict` event when hook token already exists
  - Remove direct entity mutation methods from storage

- Updated dependencies [[`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae), [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae), [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae), [`b16a682`](https://github.com/vercel/workflow/commit/b16a6828af36a2d5adb38fb6a6d1253657001ac8), [`1060f9d`](https://github.com/vercel/workflow/commit/1060f9d04a372bf6de6c5c3d52063bcc22dba6e8), [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae), [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae)]:
  - @workflow/world@4.1.0-beta.1
  - @workflow/errors@4.1.0-beta.14
  - @workflow/utils@4.1.0-beta.11

## 4.0.1-beta.27

### Patch Changes

- [#818](https://github.com/vercel/workflow/pull/818) [`202c524`](https://github.com/vercel/workflow/commit/202c524723932fc5342d33f4b57d26c25c7f9e64) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add retry for filesystem operation errors on Windows

- [#816](https://github.com/vercel/workflow/pull/816) [`5ba82ec`](https://github.com/vercel/workflow/commit/5ba82ec4b105d11538be6ad65449986eaf945916) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add support for setting `WORKFLOW_LOCAL_BASE_URL` env var

- [#824](https://github.com/vercel/workflow/pull/824) [`b05dbd7`](https://github.com/vercel/workflow/commit/b05dbd7525c1a4b4027a28e0f4eae9da87ea5788) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Clamp setTimeout value to 32-bit integer (~25d) for `sleep()`

## 4.0.1-beta.26

### Patch Changes

- Updated dependencies [[`61fdb41`](https://github.com/vercel/workflow/commit/61fdb41e1b5cd52c7b23fa3c0f3fcaa50c4189ca), [`0aa835f`](https://github.com/vercel/workflow/commit/0aa835fe30d4d61e2d6dcde693d6fbb24be72c66)]:
  - @workflow/world@4.0.1-beta.13
  - @workflow/errors@4.0.1-beta.13

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
