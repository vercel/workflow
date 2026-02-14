# @workflow/core

## 4.1.0-beta.57

## 4.1.0-beta.56

### Patch Changes

- [#1015](https://github.com/vercel/workflow/pull/1015) [`c56dc38`](https://github.com/vercel/workflow/commit/c56dc3848ecf3e188f876dc4cb7861df185bd4fb) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Extract browser-safe serialization format from `@workflow/core` and split o11y hydration by environment. Data hydration now happens client-side in the browser, enabling future e2e encryption support.

- [#990](https://github.com/vercel/workflow/pull/990) [`d7d005b`](https://github.com/vercel/workflow/commit/d7d005b54b621214720518a2a19aa2cadfa23d47) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Allow `@` in workflow names to support scoped packages

- [#1011](https://github.com/vercel/workflow/pull/1011) [`8d117cd`](https://github.com/vercel/workflow/commit/8d117cd219faac53ffa90db8628defd3d7a8160d) Thanks [@pranaygp](https://github.com/pranaygp)! - Retry 5xx errors from workflow-server in step handler to avoid consuming step attempts on transient infrastructure errors

- [#1020](https://github.com/vercel/workflow/pull/1020) [`63caf93`](https://github.com/vercel/workflow/commit/63caf931380b8211f1948cf44eac7532f33e660d) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add format prefix and length-prefix framing to stream chunks for consistent serialization with step inputs/outputs. Backwards compatible with legacy newline-delimited streams.

- [#992](https://github.com/vercel/workflow/pull/992) [`dc2dc6a`](https://github.com/vercel/workflow/commit/dc2dc6ac7908e57be9ab34140addfe98a9246fc7) Thanks [@ijjk](https://github.com/ijjk)! - stop esbuild bundling for deferred step route in Next.js

- Updated dependencies [[`63caf93`](https://github.com/vercel/workflow/commit/63caf931380b8211f1948cf44eac7532f33e660d)]:
  - @workflow/world-local@4.1.0-beta.32

## 4.1.0-beta.55

### Patch Changes

- [#998](https://github.com/vercel/workflow/pull/998) [`3d770d5`](https://github.com/vercel/workflow/commit/3d770d53855ce7c8522d4f0afbdbc123eae6c1ee) Thanks [@ijjk](https://github.com/ijjk)! - Expose workflows manifest under diagnostics folder

- [#976](https://github.com/vercel/workflow/pull/976) [`a5935ab`](https://github.com/vercel/workflow/commit/a5935abec7c7e57b2a89c629203d567cd7ac76a7) Thanks [@ijjk](https://github.com/ijjk)! - Add lazy workflow/step discovery via deferredEntries in next

- [#989](https://github.com/vercel/workflow/pull/989) [`fc4cad6`](https://github.com/vercel/workflow/commit/fc4cad68088b0f4fa4e5eeb828e2af29e05d4fe1) Thanks [@karthikscale3](https://github.com/karthikscale3)! - Normalize errors cleanly so objects get destructured

- [#966](https://github.com/vercel/workflow/pull/966) [`56f2221`](https://github.com/vercel/workflow/commit/56f22219b338a5a2c29466798a5ad36a6a450498) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Add 429 throttle retry handling and 500 server error retry with exponential backoff to the workflow and step runtimes

- Updated dependencies [[`3d770d5`](https://github.com/vercel/workflow/commit/3d770d53855ce7c8522d4f0afbdbc123eae6c1ee), [`56f2221`](https://github.com/vercel/workflow/commit/56f22219b338a5a2c29466798a5ad36a6a450498)]:
  - @workflow/utils@4.1.0-beta.12
  - @workflow/errors@4.1.0-beta.15
  - @workflow/world@4.1.0-beta.4
  - @workflow/world-vercel@4.1.0-beta.32
  - @workflow/world-local@4.1.0-beta.31

## 4.1.0-beta.54

### Patch Changes

- [#924](https://github.com/vercel/workflow/pull/924) [`fcfaf8b`](https://github.com/vercel/workflow/commit/fcfaf8bbaa912b1767c646592e539d5f98cd1e9c) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Set `stepId` property on function in `registerStepFunction` for serialization support

- [#954](https://github.com/vercel/workflow/pull/954) [`d9e9859`](https://github.com/vercel/workflow/commit/d9e98590fae17fd090e0be4f0b54bbaa80c7be69) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Generate runId client-side in start() and simplify runId types

  The `runId` is now generated client-side using ULID before serialization, rather than waiting for the server response. This simplifies the `Streamer` interface and `WorkflowServerWritableStream` to accept `string` instead of `string | Promise<string>` for `runId`.

- [#951](https://github.com/vercel/workflow/pull/951) [`f7fd88e`](https://github.com/vercel/workflow/commit/f7fd88ea963e127e62c8d527dcfdb895ba646fc2) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Tidy health check latency calculation

- Updated dependencies [[`d9e9859`](https://github.com/vercel/workflow/commit/d9e98590fae17fd090e0be4f0b54bbaa80c7be69), [`aa448c2`](https://github.com/vercel/workflow/commit/aa448c29b4c3853985eaa1bcbbf2029165edade3)]:
  - @workflow/world@4.1.0-beta.3
  - @workflow/world-vercel@4.1.0-beta.31
  - @workflow/errors@4.1.0-beta.14
  - @workflow/world-local@4.1.0-beta.30

## 4.1.0-beta.53

### Patch Changes

- [#922](https://github.com/vercel/workflow/pull/922) [`0ce46b9`](https://github.com/vercel/workflow/commit/0ce46b91d9c8ca3349f43cdf3a5d75a948d6f5ad) Thanks [@pranaygp](https://github.com/pranaygp)! - Add support for custom headers in queue messages

- [#927](https://github.com/vercel/workflow/pull/927) [`f090de1`](https://github.com/vercel/workflow/commit/f090de1eb48ad8ec3fd776e9d084310d56a7ac29) Thanks [@karthikscale3](https://github.com/karthikscale3)! - Added subpatch exports for runtime modules to allow direct imports in core. Refactored web-shared to be a thin package that exported UI components and world-actions. Updated web package to consume the UI components and world-actions from web-shared.

- [#933](https://github.com/vercel/workflow/pull/933) [`79e988f`](https://github.com/vercel/workflow/commit/79e988fa85f0ebdd5c8913b8de84e01c55d020b9) Thanks [@pranaygp](https://github.com/pranaygp)! - Add OTEL tracing for event loading and queue timing breakdown using standard OTEL semantic conventions

- [#867](https://github.com/vercel/workflow/pull/867) [`c54ba21`](https://github.com/vercel/workflow/commit/c54ba21c19040577ed95f6264a2670f190e1d1d3) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add optional `writeToStreamMulti` function to the World interface

- [#935](https://github.com/vercel/workflow/pull/935) [`e0061b8`](https://github.com/vercel/workflow/commit/e0061b861d0e3c3dc15853aed331fb1bbab71408) Thanks [@pranaygp](https://github.com/pranaygp)! - Improve logging: consolidate to structured logger, fix log levels, ensure errors/warnings are always visible

- [#873](https://github.com/vercel/workflow/pull/873) [`38e8d55`](https://github.com/vercel/workflow/commit/38e8d5571d2ee4b80387943f8f39a93b6e4bc751) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Ensure class serialization / deserialization only happens in the proper global context

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

- [#947](https://github.com/vercel/workflow/pull/947) [`efb33b2`](https://github.com/vercel/workflow/commit/efb33b2b5edf6ccb1ec2f02f1d99f2a009333780) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Pass class as `this` context to custom serializer/deserializer methods

- [#932](https://github.com/vercel/workflow/pull/932) [`088de0a`](https://github.com/vercel/workflow/commit/088de0ae422bb7c958109d689127691cea5753b6) Thanks [@pranaygp](https://github.com/pranaygp)! - Optimize step handler performance and improve server-side validation
  - Skip initial `world.steps.get()` call in step handler (saves one HTTP round-trip)
  - Add server-side `retryAfter` validation to local and postgres worlds (HTTP 425 when not reached)
  - Fix HTTP status code for step terminal state: return 409 (Conflict) instead of 410
  - Fix race condition: await `step_started` event before hydration to ensure correct attempt count

- Updated dependencies [[`0ce46b9`](https://github.com/vercel/workflow/commit/0ce46b91d9c8ca3349f43cdf3a5d75a948d6f5ad), [`c54ba21`](https://github.com/vercel/workflow/commit/c54ba21c19040577ed95f6264a2670f190e1d1d3), [`088de0a`](https://github.com/vercel/workflow/commit/088de0ae422bb7c958109d689127691cea5753b6), [`088de0a`](https://github.com/vercel/workflow/commit/088de0ae422bb7c958109d689127691cea5753b6), [`79e988f`](https://github.com/vercel/workflow/commit/79e988fa85f0ebdd5c8913b8de84e01c55d020b9), [`088de0a`](https://github.com/vercel/workflow/commit/088de0ae422bb7c958109d689127691cea5753b6)]:
  - @workflow/world@4.1.0-beta.2
  - @workflow/world-vercel@4.1.0-beta.30
  - @workflow/world-local@4.1.0-beta.29
  - @workflow/errors@4.1.0-beta.14

## 4.1.0-beta.52

### Patch Changes

- [#916](https://github.com/vercel/workflow/pull/916) [`e4e3281`](https://github.com/vercel/workflow/commit/e4e32812f8f181ad4db72e76f62ba1edf2477b12) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Fix circular dependency between runtime.ts and runtime/start.ts that caused issues with Bun's module resolution

## 4.1.0-beta.51

### Minor Changes

- [#621](https://github.com/vercel/workflow/pull/621) [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae) Thanks [@pranaygp](https://github.com/pranaygp)! - **BREAKING**: Storage interface is now read-only; all mutations go through `events.create()`
  - Remove `cancel`, `pause`, `resume` from `runs`
  - Remove `create`, `update` from `runs`, `steps`, `hooks`
  - Add run lifecycle events: `run_created`, `run_started`, `run_completed`, `run_failed`, `run_cancelled`
  - Add `step_created` event type
  - Remove `fatal` field from `step_failed` (terminal failure is now implicit)
  - Add `step_retrying` event with error info for retriable failures

### Patch Changes

- [#621](https://github.com/vercel/workflow/pull/621) [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae) Thanks [@pranaygp](https://github.com/pranaygp)! - Runtime uses event-sourced entity creation
  - Suspension handler creates entities via `events.create()`
  - Track `hasCreatedEvent` flag to avoid duplicate event creation on replay
  - Handle `hook_conflict` events during replay to reject duplicate token hooks

- [#894](https://github.com/vercel/workflow/pull/894) [`a2b688d`](https://github.com/vercel/workflow/commit/a2b688d0623ebbae117877a696c5b9b288d628fd) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Fix resuming v1 hooks and cancelling/re-running v1 runs from a v2 UI or runtime

- [#884](https://github.com/vercel/workflow/pull/884) [`1f684df`](https://github.com/vercel/workflow/commit/1f684df6b7b9cd322d5f1aa4a70dcaa3e07c7986) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add a format identifier prefix for serialized data

- [#814](https://github.com/vercel/workflow/pull/814) [`b16a682`](https://github.com/vercel/workflow/commit/b16a6828af36a2d5adb38fb6a6d1253657001ac8) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Move "parse-name" into the `utils` package

- [#833](https://github.com/vercel/workflow/pull/833) [`bd8116d`](https://github.com/vercel/workflow/commit/bd8116d40bf8d662537bf015d2861f6d1768d69e) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Remove `skipProxy` and `baseUrl` config options, simplify proxy logic

- [#853](https://github.com/vercel/workflow/pull/853) [`1060f9d`](https://github.com/vercel/workflow/commit/1060f9d04a372bf6de6c5c3d52063bcc22dba6e8) Thanks [@TooTallNate](https://github.com/TooTallNate)! - **BREAKING CHANGE**: Change user input/output to be binary data (Uint8Array) at the World interface

  This is part of specVersion 2 changes where serialization of workflow and step data uses binary format instead of JSON arrays. This allows the workflow client to be fully responsible for the data serialization format and enables future enhancements such as encryption and compression without the World implementation needing to care about the underlying data representation.

- [#855](https://github.com/vercel/workflow/pull/855) [`00c7961`](https://github.com/vercel/workflow/commit/00c7961ecb09418d6c23e1346a1b6569eb66a6bf) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Remove unused `getWritable` stub function

- [#868](https://github.com/vercel/workflow/pull/868) [`c45bc3f`](https://github.com/vercel/workflow/commit/c45bc3fd15ca201ee568cf7789ff1467cf7ba566) Thanks [@pranaygp](https://github.com/pranaygp)! - Add SDK version to workflow run executionContext for observability

- Updated dependencies [[`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae), [`26a9833`](https://github.com/vercel/workflow/commit/26a98330d478dd76192d9897b5a0cc0cf3feacd7), [`b59559b`](https://github.com/vercel/workflow/commit/b59559be70e839025680c4f9873d521170e48e1c), [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae), [`a2b688d`](https://github.com/vercel/workflow/commit/a2b688d0623ebbae117877a696c5b9b288d628fd), [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae), [`b16a682`](https://github.com/vercel/workflow/commit/b16a6828af36a2d5adb38fb6a6d1253657001ac8), [`bd8116d`](https://github.com/vercel/workflow/commit/bd8116d40bf8d662537bf015d2861f6d1768d69e), [`1060f9d`](https://github.com/vercel/workflow/commit/1060f9d04a372bf6de6c5c3d52063bcc22dba6e8), [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae), [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae), [`b973b8d`](https://github.com/vercel/workflow/commit/b973b8d00f6459fa675ee9875642e49760f68879), [`57f6376`](https://github.com/vercel/workflow/commit/57f637653d3790b9a77b2cd072bcf02fa6b61d74), [`60a9b76`](https://github.com/vercel/workflow/commit/60a9b7661a86b6bd44c25cddf68cadf0515f195e), [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae), [`4966b72`](https://github.com/vercel/workflow/commit/4966b728a8c8ac339fd98ed91af222f406479fae)]:
  - @workflow/world@4.1.0-beta.1
  - @workflow/world-local@4.1.0-beta.28
  - @workflow/errors@4.1.0-beta.14
  - @workflow/world-vercel@4.1.0-beta.29
  - @workflow/serde@4.1.0-beta.2
  - @workflow/utils@4.1.0-beta.11

## 4.0.1-beta.41

### Patch Changes

- [#816](https://github.com/vercel/workflow/pull/816) [`5ba82ec`](https://github.com/vercel/workflow/commit/5ba82ec4b105d11538be6ad65449986eaf945916) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add health check read stream retry/recovery logic

- Updated dependencies [[`202c524`](https://github.com/vercel/workflow/commit/202c524723932fc5342d33f4b57d26c25c7f9e64), [`5ba82ec`](https://github.com/vercel/workflow/commit/5ba82ec4b105d11538be6ad65449986eaf945916), [`f3785f0`](https://github.com/vercel/workflow/commit/f3785f04fbdf9e6199e0e42c592e3d5ba246a6c6), [`b05dbd7`](https://github.com/vercel/workflow/commit/b05dbd7525c1a4b4027a28e0f4eae9da87ea5788)]:
  - @workflow/world-local@4.0.1-beta.27
  - @workflow/world-vercel@4.0.1-beta.28

## 4.0.1-beta.40

### Patch Changes

- [#762](https://github.com/vercel/workflow/pull/762) [`1843704`](https://github.com/vercel/workflow/commit/1843704b83d5aaadcf1e4f5f1c73c150bd0bd2a3) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add support for custom class instance serialization

- [#809](https://github.com/vercel/workflow/pull/809) [`f93e894`](https://github.com/vercel/workflow/commit/f93e894a6a95a194637dc2ea8b19e1ad0b7653eb) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Show custom class serialization UI and class names in o11y

- Updated dependencies [[`8621917`](https://github.com/vercel/workflow/commit/8621917f6e03ae0f3833defa0f6e548434103c9d)]:
  - @workflow/serde@4.0.1-beta.1

## 4.0.1-beta.39

### Patch Changes

- [#792](https://github.com/vercel/workflow/pull/792) [`344c90f`](https://github.com/vercel/workflow/commit/344c90ff9f630addc4b41f72c2296b26e61513bc) Thanks [@ijjk](https://github.com/ijjk)! - Add Next.js pages router entries handling

- [#788](https://github.com/vercel/workflow/pull/788) [`b729d49`](https://github.com/vercel/workflow/commit/b729d49610739ae818fd56853f8ddc557591e9a1) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Allow passing custom world to runtime start() call

## 4.0.1-beta.38

### Patch Changes

- [#754](https://github.com/vercel/workflow/pull/754) [`7906429`](https://github.com/vercel/workflow/commit/7906429541672049821ec8b74452c99868db6290) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add support for serializing `this` when invoking step functions

## 4.0.1-beta.37

### Patch Changes

- [#743](https://github.com/vercel/workflow/pull/743) [`61fdb41`](https://github.com/vercel/workflow/commit/61fdb41e1b5cd52c7b23fa3c0f3fcaa50c4189ca) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add queue-based health check feature

- [#773](https://github.com/vercel/workflow/pull/773) [`3dd5b27`](https://github.com/vercel/workflow/commit/3dd5b2708de56e63c9dce9b3f2eafea63b0e3936) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Make `resumeHook()` accept a `Hook` object or string

- [#776](https://github.com/vercel/workflow/pull/776) [`49f650c`](https://github.com/vercel/workflow/commit/49f650c3a79e7b9b501cb602e3c12b75a3c4fffc) Thanks [@Timer](https://github.com/Timer)! - Fix race condition where step would stay pending forever if process crashed between database write and queue write

- [#678](https://github.com/vercel/workflow/pull/678) [`39e5774`](https://github.com/vercel/workflow/commit/39e5774de2a4c8b6a18574aa4edaf79e9f0d655e) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Fix stream serialization to resolve when user releases lock instead of waiting for stream to close. This prevents Vercel functions from hanging when users incrementally write to streams within steps (e.g., `await writer.write(data); writer.releaseLock()`). Uses a polling approach to detect when the stream lock is released and all pending writes are flushed.

- Updated dependencies [[`61fdb41`](https://github.com/vercel/workflow/commit/61fdb41e1b5cd52c7b23fa3c0f3fcaa50c4189ca), [`0aa835f`](https://github.com/vercel/workflow/commit/0aa835fe30d4d61e2d6dcde693d6fbb24be72c66)]:
  - @workflow/world@4.0.1-beta.13
  - @workflow/errors@4.0.1-beta.13
  - @workflow/world-local@4.0.1-beta.26
  - @workflow/world-vercel@4.0.1-beta.27

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
