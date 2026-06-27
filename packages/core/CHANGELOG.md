# @workflow/core

## 5.0.0-beta.25

### Patch Changes

- [#2666](https://github.com/vercel/workflow/pull/2666) [`b180270`](https://github.com/vercel/workflow/commit/b1802700e42955ae31105a8c4adce87e7965a219) Thanks [@NathanColosimo](https://github.com/NathanColosimo)! - Retry inline step completion persistence failures instead of recording them as step failures.

- [`1ea2b4e`](https://github.com/vercel/workflow/commit/1ea2b4ef77dea8ce2845867e53cf1c51a8544e6e) - Fix a turbo-mode race where step-body writes (`experimental_setAttributes` and stream writes via `getWritable`) could reach the server before the workflow run was created.

- Updated dependencies [[`5977694`](https://github.com/vercel/workflow/commit/59776946a095c56c68254dcb0761d5dec48ccdf6), [`d4e6c5b`](https://github.com/vercel/workflow/commit/d4e6c5ba34a1a3df0e07cc1891837e1435a697a8), [`a1cbc8b`](https://github.com/vercel/workflow/commit/a1cbc8b776d636f6e030889d9d521c2024bf6e60), [`48e6bbf`](https://github.com/vercel/workflow/commit/48e6bbfcc37b7997c33eb1ea3c662d553bfc5d07)]:
  - @workflow/world-local@5.0.0-beta.22
  - @workflow/world-vercel@5.0.0-beta.21
  - @workflow/world@5.0.0-beta.14
  - @workflow/errors@5.0.0-beta.8

## 5.0.0-beta.24

### Patch Changes

- [#2565](https://github.com/vercel/workflow/pull/2565) [`3fd4cc5`](https://github.com/vercel/workflow/commit/3fd4cc5f3a852da08cc173b5254905e3b03df7ba) Thanks [@ijjk](https://github.com/ijjk)! - Collapse default workflow build output to a single completion summary and move detailed progress logs behind DEBUG=workflow:build.

## 5.0.0-beta.23

### Patch Changes

- [#2592](https://github.com/vercel/workflow/pull/2592) [`2bf5257`](https://github.com/vercel/workflow/commit/2bf5257f97fc4fea036717a7882dfd39bf2b3804) Thanks [@karthikscale3](https://github.com/karthikscale3)! - Add OpenTelemetry spans, turbo tagging, and generated-route module timing around `/flow` initialization.

## 5.0.0-beta.22

### Patch Changes

- [#2569](https://github.com/vercel/workflow/pull/2569) [`d108ba3`](https://github.com/vercel/workflow/commit/d108ba32a76d516deadaa7264aec79412d862626) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Turbo mode now tells world-vercel to skip the run_started event-log preload it never reads, reducing request time.

- Updated dependencies [[`25c3df7`](https://github.com/vercel/workflow/commit/25c3df74f88726f9336ca20e6c48fd3366c40749), [`d476d7a`](https://github.com/vercel/workflow/commit/d476d7aaf6fd58d5d7241d2152fb7a705a27c4e4), [`d108ba3`](https://github.com/vercel/workflow/commit/d108ba32a76d516deadaa7264aec79412d862626)]:
  - @workflow/world@5.0.0-beta.13
  - @workflow/world-vercel@5.0.0-beta.20
  - @workflow/errors@5.0.0-beta.8
  - @workflow/world-local@5.0.0-beta.21

## 5.0.0-beta.21

### Minor Changes

- [#2526](https://github.com/vercel/workflow/pull/2526) [`3e82a12`](https://github.com/vercel/workflow/commit/3e82a12712b1efe229ac2b1623dc6c8fc7be7055) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Add turbo mode (on by default, disable with `WORKFLOW_TURBO=0`): on the first delivery of a run's first invocation the runtime backgrounds `run_started`, skips the initial event-log load, and forces optimistic inline start so the run reaches its first steps with no preceding network round-trips. It is safe there because the first delivery has no concurrent handler to race; turbo mode deactivates once a hook or sleep is encountered.

### Patch Changes

- [#2412](https://github.com/vercel/workflow/pull/2412) [`6de5ea5`](https://github.com/vercel/workflow/commit/6de5ea5c2f32b474274f5dabe5f3663e03622ac5) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Fix a race where an `AbortController` aborted from a step was not reflected in a `controller.signal` passed to a subsequent step. The step now commits the abort's durable hook event before completing, and the workflow's suspension waits for the abort to land before serializing downstream step arguments.

- [#2472](https://github.com/vercel/workflow/pull/2472) [`66ca0dc`](https://github.com/vercel/workflow/commit/66ca0dcc096440f39dd234e04669e1fc7bf2d615) Thanks [@pranaygp](https://github.com/pranaygp)! - Memoize hydrated step return values across inline replay iterations, turning the per-invocation step-result decrypt+parse cost from O(N²) to O(N) for sequential workflows. Only primitive results are cached, so deterministic replay is preserved.

## 5.0.0-beta.20

### Minor Changes

- [#2525](https://github.com/vercel/workflow/pull/2525) [`7aee0d4`](https://github.com/vercel/workflow/commit/7aee0d4e4aae627d900068a4740fd69e651d1a2f) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Derive the workflow VM's deterministic RNG seed from `runId:workflowName:deploymentId` (instead of including the run's `startedAt`) and its initial fixed clock from the ULID timestamp embedded in `runId`. These inputs are all available the moment a queue message arrives, decoupling VM setup from the `run_started` round-trip. Note: this changes the seed-derived value sequence (step/hook correlation IDs, nanoids, random values) for a given run, so runs started before this change must not be replayed across the upgrade.

- [#2516](https://github.com/vercel/workflow/pull/2516) [`84ccd40`](https://github.com/vercel/workflow/commit/84ccd40ea3e12ba6b67967a4ff9f0b84b2393c48) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Inline execution now runs up to `WORKFLOW_MAX_INLINE_STEPS` (default 3) steps in parallel per suspension, each lazily created. An opt-in `WORKFLOW_OPTIMISTIC_INLINE_START` (default off) additionally starts step bodies before `step_started` is confirmed, reconciling the in-flight start before the terminal write so a lost create-claim is discarded; it is off by default because under contention a step body can run more than once (e.g. two runs writing to the workflow stream can corrupt it), so only enable it for idempotent steps.

### Patch Changes

- [#2473](https://github.com/vercel/workflow/pull/2473) [`16b3670`](https://github.com/vercel/workflow/commit/16b36703e2b1102df33bb301e8b19d7031dbb70f) Thanks [@pranaygp](https://github.com/pranaygp)! - Drain consecutively consumable replay events in a single synchronous pass instead of one `process.nextTick` per event, removing O(N) macrotask hops from replay.

- [#2475](https://github.com/vercel/workflow/pull/2475) [`2074f91`](https://github.com/vercel/workflow/commit/2074f91b86c43267549625fd89f597c7bedf44ca) Thanks [@pranaygp](https://github.com/pranaygp)! - Skip the per-step incremental `events.list` round-trip in the inline sequential loop by consuming an event-log delta returned from the step's terminal write (gated to the single-step case with no open hooks or waits).

  Add the opt-in `CreateEventParams.sinceCursor` contract so a step-terminal `events.create` can return the event-log delta since that cursor (via `EventResult.events`/`cursor`/`hasMore`).

  Return the inline delta from a step-terminal write when `sinceCursor` is supplied, computed identically to `events.list` so the consumed prefix cannot skew from the server log.

  Forward `sinceCursor` over the v4 wire in `@workflow/world-vercel` so the server can return the delta on a step-terminal response; older servers ignore it and the runtime falls back to `events.list`.

- [#2478](https://github.com/vercel/workflow/pull/2478) [`e7ef9d8`](https://github.com/vercel/workflow/commit/e7ef9d823bd6c962d9c0c62e50e4883848c270f9) Thanks [@pranaygp](https://github.com/pranaygp)! - Lazy inline step start: the owned-inline runtime path now sends a single `step_started` carrying the step input, letting the world create the step on the fly and saving one round-trip per inline step.

  `@workflow/world`: `step_started` event data accepts an optional `input`, and `EventResult` gains a `stepCreated` ownership signal.

  `@workflow/world-local`: `step_started` with input atomically creates the step plus a synthetic `step_created` event; a lazy `step_started` for an already-existing step throws `EntityConflictError` so concurrent losers skip (exactly-once).

  `@workflow/world-postgres`: same lazy-create + exactly-once create-claim for the Postgres backend.

  `@workflow/world-vercel`: sends the step input on `step_started` over the v4 wire and threads the server's `stepCreated` signal into `EventResult`.

- [#2522](https://github.com/vercel/workflow/pull/2522) [`722bb7c`](https://github.com/vercel/workflow/commit/722bb7c6a20a7f255757280739d8b51661ed7792) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Cache the local dev server port per process so workflow replays no longer re-run OS port discovery (which spawns `lsof` on macOS, ~60ms) on every replay.

- [#2527](https://github.com/vercel/workflow/pull/2527) [`de91f20`](https://github.com/vercel/workflow/commit/de91f20f6828904a2da1d80c9f6ae729438a453b) Thanks [@karthikscale3](https://github.com/karthikscale3)! - Refine `WORKFLOW_TRACE_MODE=linked` (the default) so each queue-delivered `workflow.execute` / `step.execute` span nests under its local delivery context instead of starting a new trace root.

- [#2511](https://github.com/vercel/workflow/pull/2511) [`ab2e9b8`](https://github.com/vercel/workflow/commit/ab2e9b8d0740c457f80e05f05c1fd907bcf4f027) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Emit `workflowName` on per-step events (`step_created`, `step_completed`, and lazy-start `step_started`) so Worlds can access it without additional queries

- [#2471](https://github.com/vercel/workflow/pull/2471) [`939890d`](https://github.com/vercel/workflow/commit/939890d4c2998823d95732dbc310712709618bc9) Thanks [@pranaygp](https://github.com/pranaygp)! - Cache the compiled workflow-bundle `vm.Script` per process so replays reuse the compiled bundle instead of re-parsing it on every iteration.

- [#2490](https://github.com/vercel/workflow/pull/2490) [`a92c16d`](https://github.com/vercel/workflow/commit/a92c16debd46f3804b01682eadfbfc355f03921c) Thanks [@pranaygp](https://github.com/pranaygp)! - Reject an explicit empty-string `token` in `createHook()`. Omit the option (or pass `undefined`) to get a randomly generated token, or pass a non-empty string.

- [#2529](https://github.com/vercel/workflow/pull/2529) [`37312ed`](https://github.com/vercel/workflow/commit/37312edd0a9ae973113c9ef8d5fe6a25b603063a) Thanks [@pranaygp](https://github.com/pranaygp)! - Speed up workflow stack-trace remapping when source maps are absent (production default): skip bundle scanning when no frame references the workflow file and memoize parsed source maps per bundle.

- Updated dependencies [[`b563126`](https://github.com/vercel/workflow/commit/b563126aa1b7e4ea0a7119e78e39b98a8efee95f), [`2074f91`](https://github.com/vercel/workflow/commit/2074f91b86c43267549625fd89f597c7bedf44ca), [`e7ef9d8`](https://github.com/vercel/workflow/commit/e7ef9d823bd6c962d9c0c62e50e4883848c270f9), [`ab2e9b8`](https://github.com/vercel/workflow/commit/ab2e9b8d0740c457f80e05f05c1fd907bcf4f027), [`1332da3`](https://github.com/vercel/workflow/commit/1332da3df901b133aebb4c16e661984e147ca72f), [`fb5abbb`](https://github.com/vercel/workflow/commit/fb5abbbaf289c0c8974b98e302fe7f8868656dbc), [`90efb96`](https://github.com/vercel/workflow/commit/90efb9653c0f289c3207a8a2f192f2b5ca8c2d61)]:
  - @workflow/world-local@5.0.0-beta.20
  - @workflow/world-vercel@5.0.0-beta.19
  - @workflow/world@5.0.0-beta.12
  - @workflow/errors@5.0.0-beta.8

## 5.0.0-beta.19

### Patch Changes

- Updated dependencies [[`26fd184`](https://github.com/vercel/workflow/commit/26fd18427855070baa792cad746fcda7955cc73e)]:
  - @workflow/world-vercel@5.0.0-beta.18

## 5.0.0-beta.18

### Minor Changes

- [#2394](https://github.com/vercel/workflow/pull/2394) [`5f0b845`](https://github.com/vercel/workflow/commit/5f0b845211152b6f2860c78d0dd4dccc9d4f0d97) Thanks [@pranaygp](https://github.com/pranaygp)! - Compress serialized payloads (step inputs/outputs, workflow arguments/return values, errors, hook payloads) before storage using composable codec format prefixes. zstd is the preferred codec (markedly faster than gzip at an equal-or-better ratio, via `node:zlib`); gzip (`CompressionStream`) is the portable fallback when zstd is unavailable. Reads dispatch on the prefix, so both codecs are always decodable. Compression is applied before encryption, gated on run specVersion 5, and skipped for small or incompressible payloads. `WORKFLOW_DISABLE_COMPRESSION=1` disables writes; `WORKFLOW_COMPRESSION_CODEC=gzip` forces the portable codec.

### Patch Changes

- [#2394](https://github.com/vercel/workflow/pull/2394) [`5f0b845`](https://github.com/vercel/workflow/commit/5f0b845211152b6f2860c78d0dd4dccc9d4f0d97) Thanks [@pranaygp](https://github.com/pranaygp)! - Emit OpenTelemetry span attributes for payload compression on the serialize (write) and deserialize (read) paths: `workflow.serialization.{operation,compressed,uncompressed_bytes,stored_bytes,compression_ratio}`. Sizes are measured at the compression boundary (pre-encryption). Telemetry failures never affect serialization.

- [#2397](https://github.com/vercel/workflow/pull/2397) [`4b7a720`](https://github.com/vercel/workflow/commit/4b7a7203bf7093a435a9c4fc33a3af1060f010f7) Thanks [@pranaygp](https://github.com/pranaygp)! - `start({ deploymentId: 'latest' })` is now a no-op in Worlds that don't support atomic deployments (local dev, Postgres) instead of throwing — it logs a warning and targets the current deployment, so workflows that use `'latest'` on Vercel still run locally.

- [#2470](https://github.com/vercel/workflow/pull/2470) [`3c79c56`](https://github.com/vercel/workflow/commit/3c79c56af257b4c327e4363c0cdb482149b55c73) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Fix the payload-compression capability cutoff: gzip/zstd are gated on `5.0.0-beta.18` (the first published version containing the compression read path) instead of `5.0.0-beta.16`. The previous cutoff would let a producer write compressed payloads to a beta.16/beta.17 target that cannot decode them.

- Updated dependencies [[`5f0b845`](https://github.com/vercel/workflow/commit/5f0b845211152b6f2860c78d0dd4dccc9d4f0d97), [`5f0b845`](https://github.com/vercel/workflow/commit/5f0b845211152b6f2860c78d0dd4dccc9d4f0d97), [`6aa1ce0`](https://github.com/vercel/workflow/commit/6aa1ce0054d0af80c25bb47b7d6d726320f0e5b4)]:
  - @workflow/world-vercel@5.0.0-beta.17
  - @workflow/world@5.0.0-beta.11
  - @workflow/errors@5.0.0-beta.8
  - @workflow/world-local@5.0.0-beta.19

## 5.0.0-beta.17

### Minor Changes

- [#2363](https://github.com/vercel/workflow/pull/2363) [`926a5e7`](https://github.com/vercel/workflow/commit/926a5e7c6a50c1e74f2e2cc37324caa0f6442d85) Thanks [@karthikscale3](https://github.com/karthikscale3)! - Add `WORKFLOW_TRACE_MODE` with a new `linked` default: each workflow/step invocation span is now its own trace root with span links to the delivery and run-origin contexts, instead of one trace spanning the entire run. world-vercel now explicitly injects W3C `traceparent`/`tracestate`/`baggage` headers on outgoing workflow-server requests.

  Span names are also friendlier: workflow and step spans now use the short function name (e.g. `workflow.execute processOrder`, `step.execute chargeCard`, `workflow.start processOrder`) instead of the uppercase prefixes and full machine names (`WORKFLOW_V2 workflow//./src/jobs/order//processOrder`). The full name remains available in the `workflow.name` / `step.name` span attributes, and new `workflowDisplayName` / `stepDisplayName` helpers are exported from `@workflow/utils`.

  Behavioral changes to telemetry under the new default (set `WORKFLOW_TRACE_MODE=continuous` to restore the previous trace shape exactly; the span-name change applies in both modes):
  - A run no longer shares one trace ID: the trace of the request that called `start()` no longer contains the workflow's execution spans — navigate via span links or the `workflow.run.id` attribute instead.
  - Sampling decisions are made independently per invocation root (previously one parent-based decision covered the whole run), and the number of root spans/traces increases to one per invocation.
  - `workflow.execute`/`step.execute` invocation spans (formerly `WORKFLOW_V2`/`STEP`) become parentless roots, which changes parent/child-based queries and service-map edges.
  - Re-enqueued queue messages forward the original run-origin trace carrier unchanged, rather than each invocation's current context.
  - Queries or dashboards matching the old `WORKFLOW_V2 ...`/`STEP ...` span names must switch to the new names.
  - The queue-delivered `workflow.execute` span kind changed from `internal` to `consumer`, matching the queue-delivered `step.execute` span (this applies in both modes).

  Existing attributes and baggage keys are unchanged, and everything remains a no-op when no OpenTelemetry SDK is registered.

### Patch Changes

- Updated dependencies [[`926a5e7`](https://github.com/vercel/workflow/commit/926a5e7c6a50c1e74f2e2cc37324caa0f6442d85)]:
  - @workflow/world-vercel@5.0.0-beta.16
  - @workflow/utils@5.0.0-beta.4
  - @workflow/errors@5.0.0-beta.8
  - @workflow/world-local@5.0.0-beta.18

## 5.0.0-beta.16

### Minor Changes

- [#2385](https://github.com/vercel/workflow/pull/2385) [`628795a`](https://github.com/vercel/workflow/commit/628795aa8729bef442c7a1583cf2f3d986e9e4fc) Thanks [@pranaygp](https://github.com/pranaygp)! - Add an `allowReservedAttributes` option to `start()` so framework-level callers can seed reserved `$`-prefixed run attributes at creation, matching the existing `experimental_setAttributes` option. The flag is carried through the resilient-start queue input so lazy run creation validates identically.

### Patch Changes

- Updated dependencies [[`af859c3`](https://github.com/vercel/workflow/commit/af859c3a6db812daf6c640ff3d99488cddca8bd0), [`628795a`](https://github.com/vercel/workflow/commit/628795aa8729bef442c7a1583cf2f3d986e9e4fc), [`0178fa5`](https://github.com/vercel/workflow/commit/0178fa5730fa8b4529bc179e2ff969e0fc882eb9)]:
  - @workflow/world-local@5.0.0-beta.17
  - @workflow/world-vercel@5.0.0-beta.15
  - @workflow/world@5.0.0-beta.10
  - @workflow/errors@5.0.0-beta.7

## 5.0.0-beta.15

### Minor Changes

- [#1853](https://github.com/vercel/workflow/pull/1853) [`303b6da`](https://github.com/vercel/workflow/commit/303b6da28affe2f6cec8651b3dd11ec922619784) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add opt-in wire-level framing for byte streams (`type: 'bytes'`) so consumers can identify chunk boundaries — a prerequisite for transparent auto-reconnect. The framing decision is gated on a new `framedByteStreams` capability and recorded per-stream in the serialized ref (`framing: 'framed-v1'`); legacy raw streams continue to work unchanged.

- [#2373](https://github.com/vercel/workflow/pull/2373) [`01c8c08`](https://github.com/vercel/workflow/commit/01c8c0878a515bec4476ee2bc90b26d914822632) Thanks [@pranaygp](https://github.com/pranaygp)! - Replace `hook.hasConflict` (a `Promise<boolean>` property) with `hook.getConflict()`, a method returning a promise that suspends the workflow to commit hook registration and resolves with the conflicting `Run` when another active hook owns the token (or `null` once the hook is registered), without waiting for hook payload data. Code using `await hook.hasConflict` should migrate to `const conflict = await hook.getConflict()` and branch on `conflict !== null`.

- [#2226](https://github.com/vercel/workflow/pull/2226) [`ae8d6fe`](https://github.com/vercel/workflow/commit/ae8d6feeda0d1d31da8da70156d6e04ebb0487d0) Thanks [@pranaygp](https://github.com/pranaygp)! - Allow passing initial run attributes through `start()`, and speed up workflow-level `setAttribute` calls by using native events for recording attributes.

### Patch Changes

- [#1925](https://github.com/vercel/workflow/pull/1925) [`b3279f8`](https://github.com/vercel/workflow/commit/b3279f8b17ca5a57a364d12b5e9394f7d27fe3b2) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - V2 suspension processing: unify wait + step queue dispatch into a single parallel batch. The runtime now queues every pending operation (non-inline steps + wait timer) in one `Promise.all` and then inline-executes one owned step (if any). The asymmetric `{ timeoutSeconds }` return contract for waits is dropped from suspension processing; waits become normal queue continuations with `delaySeconds`, deduplicated per wait so repeated suspension passes don't accumulate delayed messages. Continuation delays are clamped to 23h (VQS's message-retention bound) with longer waits chained across hop-keyed messages, so multi-day `sleep()`s work on every world. This restores inline step execution for `Promise.race(step, sleep)` workflows without any of the carve-outs the prior fix needed: even when the inline step blocks the handler, the wait continuation fires in parallel and drives the next replay. As part of the same change, `world-local`'s queue now honors `delaySeconds` (matches `world-vercel` / `world-postgres`), and its `close()` aborts pending delayed deliveries and retry sleeps so dev-server/test shutdown isn't held open by wait timers.

- Updated dependencies [[`b3279f8`](https://github.com/vercel/workflow/commit/b3279f8b17ca5a57a364d12b5e9394f7d27fe3b2), [`f2a7bde`](https://github.com/vercel/workflow/commit/f2a7bdeb0abcf8a5d48c33a35b4b15aeca78cddf), [`ae8d6fe`](https://github.com/vercel/workflow/commit/ae8d6feeda0d1d31da8da70156d6e04ebb0487d0)]:
  - @workflow/world-local@5.0.0-beta.16
  - @workflow/world@5.0.0-beta.9
  - @workflow/world-vercel@5.0.0-beta.14
  - @workflow/errors@5.0.0-beta.7

## 5.0.0-beta.14

### Minor Changes

- [#2305](https://github.com/vercel/workflow/pull/2305) [`4670c4b`](https://github.com/vercel/workflow/commit/4670c4b92d7386dfd74728538c7e24fe8c07b0af) Thanks [@willsather](https://github.com/willsather)! - Add an optional `namespace` parameter that scopes queue topic prefixes to `__{namespace}_wkf_workflow_*`. This allows configuring multiple frameworks in the same deployment without queue topic collision.

### Patch Changes

- [#2345](https://github.com/vercel/workflow/pull/2345) [`bf44d4d`](https://github.com/vercel/workflow/commit/bf44d4dd0ac8891732f5a254b37e8f165b71a10d) Thanks [@pranaygp](https://github.com/pranaygp)! - Fix unhandled rejection when `step_created`/`wait_created` calls fail in `waitUntil`

- [#2318](https://github.com/vercel/workflow/pull/2318) [`eb976db`](https://github.com/vercel/workflow/commit/eb976db35bb2cd7591d6a7f3bfa20a69b1c0ad89) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Automatically reconnect object streams when the server stream connection times out.

- [#2336](https://github.com/vercel/workflow/pull/2336) [`a813382`](https://github.com/vercel/workflow/commit/a813382216e1c5d3a2f90dc97d205f17ff3f4cd0) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Fix unexpected rejections in `waitUntil` causing process crashes

- Updated dependencies [[`95d7009`](https://github.com/vercel/workflow/commit/95d7009e8a80b8e8602f10489e2a065a317e82d0), [`4670c4b`](https://github.com/vercel/workflow/commit/4670c4b92d7386dfd74728538c7e24fe8c07b0af)]:
  - @workflow/world-vercel@5.0.0-beta.13
  - @workflow/world@5.0.0-beta.8
  - @workflow/world-local@5.0.0-beta.15
  - @workflow/errors@5.0.0-beta.7

## 5.0.0-beta.13

### Minor Changes

- [#1854](https://github.com/vercel/workflow/pull/1854) [`8d75491`](https://github.com/vercel/workflow/commit/8d75491a074991dac3c7cf56823feb15354ab0f1) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Surface `workflowCoreVersion` from the responding deployment in `healthCheck()` results.

### Patch Changes

- [#2185](https://github.com/vercel/workflow/pull/2185) [`0fd0891`](https://github.com/vercel/workflow/commit/0fd0891cc4acab6d84610d3603f3cb90a33f29b0) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Fix `CorruptedEventLogError` on replay when a workflow races a hook read against a `sleep()` (e.g. `Promise.race([hook, sleep])`). Branch-deciding deliveries (buffered hook payloads and wait completions) are now handed to the workflow in strict event-log order — anchored on event position rather than on microtask-resolution timing — so the committed branch wins the race deterministically, independent of decryption/hydration time or `Promise.race` argument order.

- [#2257](https://github.com/vercel/workflow/pull/2257) [`ccd37e9`](https://github.com/vercel/workflow/commit/ccd37e9a59f1b3629815cdaf1c650610c709a580) Thanks [@pranaygp](https://github.com/pranaygp)! - Avoid unhandled run lookups for unused or empty readable streams and include Vercel request correlation headers in world transport errors.

- [#2301](https://github.com/vercel/workflow/pull/2301) [`bb6ff9a`](https://github.com/vercel/workflow/commit/bb6ff9ac99b17f1720d929d1fd2c03d5b6029ea7) Thanks [@pranaygp](https://github.com/pranaygp)! - Update vulnerable package dependencies to patched releases.

- [#2292](https://github.com/vercel/workflow/pull/2292) [`aa628b7`](https://github.com/vercel/workflow/commit/aa628b7a8fda1037100c1ac5515c6525f25decb8) Thanks [@pranaygp](https://github.com/pranaygp)! - Bump `devalue` to 5.8.1 to address published security advisories.

- Updated dependencies [[`867e339`](https://github.com/vercel/workflow/commit/867e33903da71528c857a2f9e9e8db4da200a553), [`ccd37e9`](https://github.com/vercel/workflow/commit/ccd37e9a59f1b3629815cdaf1c650610c709a580), [`81bda49`](https://github.com/vercel/workflow/commit/81bda490ef2726ef36ce457932ec94cc3abc6bc2), [`c19f38d`](https://github.com/vercel/workflow/commit/c19f38d9071f12de3a44e8f5b5442bf9dfbebd80)]:
  - @workflow/world-local@5.0.0-beta.14
  - @workflow/world-vercel@5.0.0-beta.12

## 5.0.0-beta.12

### Patch Changes

- [#2211](https://github.com/vercel/workflow/pull/2211) [`52d63d1`](https://github.com/vercel/workflow/commit/52d63d1b61303d9d58e2ad74a655dbe57e4f1b39) Thanks [@pranaygp](https://github.com/pranaygp)! - Prevent replayed workflows from advancing their deterministic clock when a future event is inspected before its matching operation is invoked.

- [#2212](https://github.com/vercel/workflow/pull/2212) [`2a3b11b`](https://github.com/vercel/workflow/commit/2a3b11bcb408f1aa071b0e37f0b2df614052acd1) Thanks [@pranaygp](https://github.com/pranaygp)! - Retry transient workflow replay divergence before classifying repeated divergence as a corrupted event log.

- [#2215](https://github.com/vercel/workflow/pull/2215) [`12c35b5`](https://github.com/vercel/workflow/commit/12c35b54ebf3d3c9fbc30462b42b05e5ce476a2b) Thanks [@pranaygp](https://github.com/pranaygp)! - Skip workflow replay when a refreshed event log already contains a terminal run event.

- Updated dependencies [[`b8a337c`](https://github.com/vercel/workflow/commit/b8a337c945cc0566b5d87e4e40026f50aa8c60ff), [`ddc8a79`](https://github.com/vercel/workflow/commit/ddc8a79741e8d281717e9fb361cf0001af460e9b), [`2a3b11b`](https://github.com/vercel/workflow/commit/2a3b11bcb408f1aa071b0e37f0b2df614052acd1), [`3a16272`](https://github.com/vercel/workflow/commit/3a16272bd363d56de58c81ef4dba75b89897a749)]:
  - @workflow/world-local@5.0.0-beta.13
  - @workflow/world-vercel@5.0.0-beta.11
  - @workflow/errors@5.0.0-beta.7
  - @workflow/world@5.0.0-beta.7

## 5.0.0-beta.11

### Patch Changes

- [#2180](https://github.com/vercel/workflow/pull/2180) [`1ee63b8`](https://github.com/vercel/workflow/commit/1ee63b870afbf9754eb1022b1bb5f02d0ab042f9) Thanks [@pranaygp](https://github.com/pranaygp)! - Harden runtime event pagination against rejected, repeated, or overlapping cursor responses.

- [#2191](https://github.com/vercel/workflow/pull/2191) [`8f68d35`](https://github.com/vercel/workflow/commit/8f68d3525ce3e420f4d16b9976c97a5598f91afd) Thanks [@pranaygp](https://github.com/pranaygp)! - Fix forwarded writable stream encryption when child workflows execute on a newer deployment than their parent.

- Updated dependencies [[`8f68d35`](https://github.com/vercel/workflow/commit/8f68d3525ce3e420f4d16b9976c97a5598f91afd), [`7994629`](https://github.com/vercel/workflow/commit/7994629b8bd0781369a4d55b7034b2b722a8c556)]:
  - @workflow/world@5.0.0-beta.6
  - @workflow/world-vercel@5.0.0-beta.10
  - @workflow/errors@5.0.0-beta.6
  - @workflow/world-local@5.0.0-beta.12

## 5.0.0-beta.10

### Patch Changes

- [#2145](https://github.com/vercel/workflow/pull/2145) [`8d0928b`](https://github.com/vercel/workflow/commit/8d0928b2a2ce61b6c05cb8930d29f176b3a83970) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Classify SDK-level AES-GCM encryption failures as `RUNTIME_ERROR` instead of `USER_ERROR` via a new `RuntimeDecryptionError`.

- Updated dependencies [[`8d0928b`](https://github.com/vercel/workflow/commit/8d0928b2a2ce61b6c05cb8930d29f176b3a83970), [`3128dfc`](https://github.com/vercel/workflow/commit/3128dfce809839a53c7cb6cc2337a9c31e0bf8a5)]:
  - @workflow/errors@5.0.0-beta.6
  - @workflow/world-local@5.0.0-beta.11
  - @workflow/world-vercel@5.0.0-beta.9

## 5.0.0-beta.9

### Patch Changes

- [#2150](https://github.com/vercel/workflow/pull/2150) [`4b5f017`](https://github.com/vercel/workflow/commit/4b5f017635b28ff164047bce8ccf4a5981748704) Thanks [@pranaygp](https://github.com/pranaygp)! - Treat serialized and cross-realm `AbortError` step failures as fatal cancellations, and stabilize abort E2E readiness checkpoints.

- [#2157](https://github.com/vercel/workflow/pull/2157) [`409b103`](https://github.com/vercel/workflow/commit/409b1033d9b7dfab9c26fda9a17494c08e43d0ae) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Allow `experimental_setAttributes()` to be called from step functions.

- [#2142](https://github.com/vercel/workflow/pull/2142) [`ae37315`](https://github.com/vercel/workflow/commit/ae37315cb708b413f2ee9945c90a23a57dfd410d) Thanks [@pranaygp](https://github.com/pranaygp)! - Prevent failed stream writes from surfacing as unhandled rejections and include request correlation details in stream errors.

- Updated dependencies [[`65336df`](https://github.com/vercel/workflow/commit/65336df9f80f228903216c3e82ea7d499d924734), [`ae37315`](https://github.com/vercel/workflow/commit/ae37315cb708b413f2ee9945c90a23a57dfd410d)]:
  - @workflow/world-local@5.0.0-beta.8
  - @workflow/world-vercel@5.0.0-beta.8

## 5.0.0-beta.8

### Patch Changes

- [#2134](https://github.com/vercel/workflow/pull/2134) [`1e6b1fd`](https://github.com/vercel/workflow/commit/1e6b1fdea2010c1f55b3e6fb5386d436c4406eb4) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Add `experimental_setAttributes()` workflow-level helper for attaching string key/value metadata to a workflow run, surfaced as `run.attributes`

- [#2086](https://github.com/vercel/workflow/pull/2086) [`2050656`](https://github.com/vercel/workflow/commit/2050656099349ededd11b33256e951cf97d88a76) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Fix `getWritable()` returning a new TransformStream per call, which caused racing pipes to reorder chunks when callers acquired a writer per write. Repeat calls within the same step now share a single pipe per `(runId, namespace)`.

- [#2134](https://github.com/vercel/workflow/pull/2134) [`1e6b1fd`](https://github.com/vercel/workflow/commit/1e6b1fdea2010c1f55b3e6fb5386d436c4406eb4) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Harden workflow error stack remapping for large inline sourcemaps.

- [#1799](https://github.com/vercel/workflow/pull/1799) [`503a929`](https://github.com/vercel/workflow/commit/503a929d347df46eb0ad63b068da7781762d0dc8) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Use inline sourcemaps for all workspace packages; published packages no longer ship external `.js.map` files.

- Updated dependencies [[`1e6b1fd`](https://github.com/vercel/workflow/commit/1e6b1fdea2010c1f55b3e6fb5386d436c4406eb4), [`62ec537`](https://github.com/vercel/workflow/commit/62ec5372fb7dc0d8d088be0c55db35d14eea5b14), [`b0d0561`](https://github.com/vercel/workflow/commit/b0d0561afc41d20b5203c02bb9a4dbf59d18c214), [`503a929`](https://github.com/vercel/workflow/commit/503a929d347df46eb0ad63b068da7781762d0dc8), [`657e8bb`](https://github.com/vercel/workflow/commit/657e8bb9629e7002c7658b98c32761e01e714474)]:
  - @workflow/world@5.0.0-beta.5
  - @workflow/world-local@5.0.0-beta.7
  - @workflow/world-vercel@5.0.0-beta.7
  - @workflow/errors@5.0.0-beta.5
  - @workflow/serde@5.0.0-beta.2
  - @workflow/utils@5.0.0-beta.3

## 5.0.0-beta.7

### Minor Changes

- [#2059](https://github.com/vercel/workflow/pull/2059) [`49da6c5`](https://github.com/vercel/workflow/commit/49da6c50b3d28f9c533ec0ee28437d7ed3887335) Thanks [@TooTallNate](https://github.com/TooTallNate)! - A `WritableStream` from a workflow's `getWritable()` can now be passed as an argument to a child workflow via `start()`; the child's writes land on the parent run's stream directly for the full lifetime of the child run.

### Patch Changes

- [#2038](https://github.com/vercel/workflow/pull/2038) [`dc0be50`](https://github.com/vercel/workflow/commit/dc0be50618bd6a465e3f9768ee7427d282aa1fd7) Thanks [@pranaygp](https://github.com/pranaygp)! - Refresh workflow events after completing elapsed waits so concurrent hook events preserve deterministic replay order.

- [#2046](https://github.com/vercel/workflow/pull/2046) [`ad71b58`](https://github.com/vercel/workflow/commit/ad71b58bba65e739fbafee0440ffff48878e7e51) Thanks [@pranaygp](https://github.com/pranaygp)! - Report corrupted event logs with a distinct `CorruptedEventLogError` type and `CORRUPTED_EVENT_LOG` run error code.

- [#2056](https://github.com/vercel/workflow/pull/2056) [`9454151`](https://github.com/vercel/workflow/commit/9454151b0e3b8a4ceeb96de4d41c5937330e16a6) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Fix spurious "Event cursor missing after initial load" warning

- [#2030](https://github.com/vercel/workflow/pull/2030) [`b124365`](https://github.com/vercel/workflow/commit/b124365e14b0c47a5c830c7009dd5bf0149d5a59) Thanks [@pranaygp](https://github.com/pranaygp)! - Validate step, wait, and hook lifecycle events against replay ownership metadata.

- [#2013](https://github.com/vercel/workflow/pull/2013) [`2a446af`](https://github.com/vercel/workflow/commit/2a446af517dbb91ae959adade1d74ef0428a2b09) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Exclude inline step execution from the workflow replay timeout. Long-running steps no longer hit `REPLAY_TIMEOUT` (fixes #2009). Adds a `WORKFLOW_REPLAY_TIMEOUT_MS` env var override and a new optional `World.processExitTriggersQueueRedelivery` capability used to gate the runtime's `process.exit(1)` failure path.

- [#2060](https://github.com/vercel/workflow/pull/2060) [`1d3959e`](https://github.com/vercel/workflow/commit/1d3959eaa8db5866d08ad3970324c1b5dae73f7b) Thanks [@pranaygp](https://github.com/pranaygp)! - Record fatal world response contract failures as non-retryable workflow errors.

- Updated dependencies [[`dc0be50`](https://github.com/vercel/workflow/commit/dc0be50618bd6a465e3f9768ee7427d282aa1fd7), [`ad71b58`](https://github.com/vercel/workflow/commit/ad71b58bba65e739fbafee0440ffff48878e7e51), [`b124365`](https://github.com/vercel/workflow/commit/b124365e14b0c47a5c830c7009dd5bf0149d5a59), [`2a446af`](https://github.com/vercel/workflow/commit/2a446af517dbb91ae959adade1d74ef0428a2b09), [`1d3959e`](https://github.com/vercel/workflow/commit/1d3959eaa8db5866d08ad3970324c1b5dae73f7b)]:
  - @workflow/world@5.0.0-beta.4
  - @workflow/world-local@5.0.0-beta.6
  - @workflow/world-vercel@5.0.0-beta.6
  - @workflow/errors@5.0.0-beta.4

## 5.0.0-beta.6

### Patch Changes

- [#2012](https://github.com/vercel/workflow/pull/2012) [`9d2a926`](https://github.com/vercel/workflow/commit/9d2a9261fd9355b8e8f41342dd8b81b272162837) Thanks [@pranaygp](https://github.com/pranaygp)! - Expose the active run ID on hook token conflict errors.

- Updated dependencies [[`9d2a926`](https://github.com/vercel/workflow/commit/9d2a9261fd9355b8e8f41342dd8b81b272162837), [`c43e721`](https://github.com/vercel/workflow/commit/c43e721efc90e93575f0e1f36221b69d50074187), [`c145bf5`](https://github.com/vercel/workflow/commit/c145bf56d98faa7b27fa1d9d4a5ead57dda6b058), [`22b5a12`](https://github.com/vercel/workflow/commit/22b5a1240f8f4dfee5536791fee981d50781ff1f)]:
  - @workflow/errors@5.0.0-beta.3
  - @workflow/world@5.0.0-beta.3
  - @workflow/world-local@5.0.0-beta.5
  - @workflow/world-vercel@5.0.0-beta.5

## 5.0.0-beta.5

### Major Changes

- [#1851](https://github.com/vercel/workflow/pull/1851) [`5f22832`](https://github.com/vercel/workflow/commit/5f228326757f7da349edfed89845bd109c98f104) Thanks [@TooTallNate](https://github.com/TooTallNate)! - **BREAKING CHANGE**: Run and step errors are now serialized through the workflow serialization pipeline, preserving original class identity and cause chains on `WorkflowRunFailedError.cause`. Pre-upgrade failed runs in the `world-postgres` legacy `error` text column surface as `error: undefined` on read; the original payload is still readable directly from the `errorJson` column for manual inspection.

### Minor Changes

- [#1511](https://github.com/vercel/workflow/pull/1511) [`e7ea068`](https://github.com/vercel/workflow/commit/e7ea0684f44b3743dbc56543ea103786ab7144bc) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add first-class serialization support for built-in Error subclasses (`TypeError`, `RangeError`, `SyntaxError`, `URIError`, `ReferenceError`, `EvalError`, `AggregateError`) and preserve the `cause` property on all Error types

- [#1513](https://github.com/vercel/workflow/pull/1513) [`74b13cd`](https://github.com/vercel/workflow/commit/74b13cd3ed3412d4e99af55587c69dc458fa5400) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add first-class serialization for `FatalError` and `RetryableError` so they round-trip with class identity preserved across all serialization boundaries (including from environments that don't run the SWC plugin)

### Patch Changes

- [#1301](https://github.com/vercel/workflow/pull/1301) [`aee5699`](https://github.com/vercel/workflow/commit/aee56993c777e6fc8d40af8d90ec3d4fbd86cdfe) Thanks [@pranaygp](https://github.com/pranaygp)! - Drain pending queue items at workflow completion instead of only logging warnings, and implicitly dispose any never-aborted system (abort) hooks at completion so unused `AbortController` instances don't leave abandoned rows in the hooks table for the run's TTL

- [#1301](https://github.com/vercel/workflow/pull/1301) [`aee5699`](https://github.com/vercel/workflow/commit/aee56993c777e6fc8d40af8d90ec3d4fbd86cdfe) Thanks [@pranaygp](https://github.com/pranaygp)! - Fix `DOMException` not serializing correctly

- [#1924](https://github.com/vercel/workflow/pull/1924) [`3535caf`](https://github.com/vercel/workflow/commit/3535caf44924cf9561e8b768c418fe1eb37d96cf) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Fix `Promise.race(step, sleep)` always blocking until step completed

- [#1849](https://github.com/vercel/workflow/pull/1849) [`1203dae`](https://github.com/vercel/workflow/commit/1203dae70c802eef114909e9476e19ec528550cd) Thanks [@pranaygp](https://github.com/pranaygp)! - Friendlier workflow error messages. New `SerializationError`, `WorkflowBuildError`, and structured context-violation classes (e.g. `NotInWorkflowContextError`) with actionable hints and docs links applied to user-facing throw sites; `FatalError.is()` recognizes any error with `fatal: true` so context violations and serialization failures now fail fast instead of burning retry attempts. Runtime logs are namespaced under `[workflow-sdk]` and gain `errorAttribution` (`user` vs `sdk`) plus class-aware hints

- [#1747](https://github.com/vercel/workflow/pull/1747) [`00a011d`](https://github.com/vercel/workflow/commit/00a011dee43b3ba7c399a97b9ed072cf4ce66816) Thanks [@ijjk](https://github.com/ijjk)! - Fix eager Next.js workflow builds with lazy discovery disabled.

- [#1849](https://github.com/vercel/workflow/pull/1849) [`1203dae`](https://github.com/vercel/workflow/commit/1203dae70c802eef114909e9476e19ec528550cd) Thanks [@pranaygp](https://github.com/pranaygp)! - Replace `util.inspect`'s default object dump for runtime structured-log metadata with an opinionated, workflow-aware formatter. The runtime logger uses color-coded metadata blocks.

- [#1301](https://github.com/vercel/workflow/pull/1301) [`aee5699`](https://github.com/vercel/workflow/commit/aee56993c777e6fc8d40af8d90ec3d4fbd86cdfe) Thanks [@pranaygp](https://github.com/pranaygp)! - Add serializable `AbortController` and `AbortSignal` support across workflow and step boundaries. Workflow code can now construct an `AbortController`, pass `signal` to steps, and call `abort()`.

  **Behavior change:** `AbortError` thrown from inside a step is now wrapped as `FatalError` and skips retry semantics. As a result, custom timeouts on `fetch` inside steps are no longer re-tried by default, and now need to be wrapped in `RetryableError` to preserve the old behavior.

- [#1299](https://github.com/vercel/workflow/pull/1299) [`9f3516e`](https://github.com/vercel/workflow/commit/9f3516ec28f15d8bb5bfa9ee57aed858301fa4fd) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Refactor `serialization.ts` into modular `serialization/` files. No runtime change.

- [#1935](https://github.com/vercel/workflow/pull/1935) [`d0e3f27`](https://github.com/vercel/workflow/commit/d0e3f2722b744472a90e48062e3876040e21de82) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Preserve the `this` binding of bound step proxies across workflow serialization, so passing `useStep(...).bind(thisArg)` as a step argument no longer loses the receiver.

- [#1338](https://github.com/vercel/workflow/pull/1338) [`8ea1532`](https://github.com/vercel/workflow/commit/8ea1532e48ed86ef9a66231e474851bed85c737a) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Merge flow and step routes into a single combined handler that executes steps inline when possible, reducing function invocations and queue overhead.

- [#1951](https://github.com/vercel/workflow/pull/1951) [`72911f7`](https://github.com/vercel/workflow/commit/72911f7356238b0ef803455641f8ef5c9dd1545c) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Fix `world.ts` being tree-shaken out of the bundle and unavailable at runtime

- Updated dependencies [[`540a2ef`](https://github.com/vercel/workflow/commit/540a2efb99c137b0d60c7368376e9533ea662a4c), [`92dc826`](https://github.com/vercel/workflow/commit/92dc82608ab7526e930eeedd4752c68872bae639), [`5eb0b79`](https://github.com/vercel/workflow/commit/5eb0b792b8a7f04d6558f27d4b0d29daa57a788d), [`5374148`](https://github.com/vercel/workflow/commit/537414849b0f7022640879786ff85c918672e7d0), [`1203dae`](https://github.com/vercel/workflow/commit/1203dae70c802eef114909e9476e19ec528550cd), [`1203dae`](https://github.com/vercel/workflow/commit/1203dae70c802eef114909e9476e19ec528550cd), [`5f22832`](https://github.com/vercel/workflow/commit/5f228326757f7da349edfed89845bd109c98f104), [`2f52d14`](https://github.com/vercel/workflow/commit/2f52d14f3844c999f6b89baeb8e04289d6dd34a9), [`8ea1532`](https://github.com/vercel/workflow/commit/8ea1532e48ed86ef9a66231e474851bed85c737a), [`c1163eb`](https://github.com/vercel/workflow/commit/c1163eb146991a4924d80bcc9cfcc8bb89e05067), [`cd50618`](https://github.com/vercel/workflow/commit/cd50618d1fc01ee6049047e415b794dd7ca54af9)]:
  - @workflow/errors@5.0.0-beta.2
  - @workflow/world-local@5.0.0-beta.4
  - @workflow/world-vercel@5.0.0-beta.4
  - @workflow/world@5.0.0-beta.2
  - @workflow/utils@5.0.0-beta.2

## 5.0.0-beta.4

## 5.0.0-beta.3

### Minor Changes

- [#1491](https://github.com/vercel/workflow/pull/1491) [`e295bae`](https://github.com/vercel/workflow/commit/e295bae417bd072f8e18e8d07c76d90d40ae7cec) Thanks [@pranaygp](https://github.com/pranaygp)! - Allow `start()` to be called directly inside workflow functions

### Patch Changes

- [#1848](https://github.com/vercel/workflow/pull/1848) [`7d07fab`](https://github.com/vercel/workflow/commit/7d07fab692ba79d0339b093a45f5beecb219639e) Thanks [@pranaygp](https://github.com/pranaygp)! - Replace `eval` in `serialization.ts` `revive()` helper with `JSON.parse`. `devalue.stringify()` output is always valid JSON (special values are encoded as negative integer sentinels), so `JSON.parse` is a safe drop-in that eliminates the `eval` anti-pattern.

- Updated dependencies [[`3ad8ee7`](https://github.com/vercel/workflow/commit/3ad8ee7e33e4639cf0e4778c1e87b96a17a74c56), [`354840e`](https://github.com/vercel/workflow/commit/354840e93b46e2eae29d4b1f936b04a92db1890e)]:
  - @workflow/world-local@5.0.0-beta.3
  - @workflow/world-vercel@5.0.0-beta.3

## 5.0.0-beta.2

### Patch Changes

- [#1716](https://github.com/vercel/workflow/pull/1716) [`df115fd`](https://github.com/vercel/workflow/commit/df115fde8cb4baa9a02477db043bf3d6d97259c8) Thanks [@karthikscale3](https://github.com/karthikscale3)! - Make encrypted markers clickable to trigger decryption and detect encryption at run level before span selection. Persist `features.encryption` flag in `executionContext` at run creation so the UI can detect encryption without a probe fetch.

- [#1740](https://github.com/vercel/workflow/pull/1740) [`0810b75`](https://github.com/vercel/workflow/commit/0810b75872e96d8d8aa6e3dbf4236304d57526a7) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - When runtime replays exceed 240s, re-try them up to three times, instead of failing immediately

- [#1769](https://github.com/vercel/workflow/pull/1769) [`5a42964`](https://github.com/vercel/workflow/commit/5a4296412f151c255a8d08c8870e511222c7c472) Thanks [@tomdale](https://github.com/tomdale)! - Embed source content in published sourcemaps.

- [#1778](https://github.com/vercel/workflow/pull/1778) [`b7d6595`](https://github.com/vercel/workflow/commit/b7d6595c25dab6fe902a47e699b1818ecf1efb86) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Fix false-positive unconsumed `step_created` errors when replay resumes a `for await` hook loop and appends more async work after the first promise-queue drain.

- [#1681](https://github.com/vercel/workflow/pull/1681) [`ac09f40`](https://github.com/vercel/workflow/commit/ac09f407719413671b6feea4dca2360ebda9a51f) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add clickable Run reference rendering in observability UI

- [#1759](https://github.com/vercel/workflow/pull/1759) [`173756d`](https://github.com/vercel/workflow/commit/173756dc4d097fd90432e2c38c91ce1b959a6352) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Rename `useworkflow.dev` URLs to `workflow-sdk.dev`

- Updated dependencies [[`340c085`](https://github.com/vercel/workflow/commit/340c0856813b23e9be966a2022933d6040a3b062), [`5a42964`](https://github.com/vercel/workflow/commit/5a4296412f151c255a8d08c8870e511222c7c472), [`11cfb8f`](https://github.com/vercel/workflow/commit/11cfb8f3fb4c64bde92cf51a5990a7773c263f94), [`173756d`](https://github.com/vercel/workflow/commit/173756dc4d097fd90432e2c38c91ce1b959a6352)]:
  - @workflow/world-vercel@5.0.0-beta.2
  - @workflow/errors@5.0.0-beta.1
  - @workflow/serde@5.0.0-beta.1
  - @workflow/utils@5.0.0-beta.1
  - @workflow/world-local@5.0.0-beta.2

## 5.0.0-beta.1

### Major Changes

- [#1293](https://github.com/vercel/workflow/pull/1293) [`66d49c0`](https://github.com/vercel/workflow/commit/66d49c0db608b034c8fc1b4087a047e0be067b77) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - **BREAKING CHANGE**: Restructure stream methods on World interface to use `world.streams.*` namespace with `runId` as the first parameter. `writeToStream(name, runId, chunk)` → `streams.write(runId, name, chunk)`, `writeToStreamMulti` → `streams.writeMulti`, `closeStream` → `streams.close`, `readFromStream` → `streams.get(runId, name, startIndex?)`, `listStreamsByRunId` → `streams.list(runId)`.

- [#1632](https://github.com/vercel/workflow/pull/1632) [`0a86de3`](https://github.com/vercel/workflow/commit/0a86de3afd1b51efff32e1c3cefd7f384d1b2d8d) Thanks [@TooTallNate](https://github.com/TooTallNate)! - **BREAKING CHANGE**: Remove `@workflow/core/private` and `workflow/internal/private` public subpath exports. The SWC compiler plugin no longer generates imports from these paths.

- [#1293](https://github.com/vercel/workflow/pull/1293) [`66d49c0`](https://github.com/vercel/workflow/commit/66d49c0db608b034c8fc1b4087a047e0be067b77) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Require `runId` argument for `world.steps.get`.

### Minor Changes

- [#1652](https://github.com/vercel/workflow/pull/1652) [`ec517fa`](https://github.com/vercel/workflow/commit/ec517fa2254131f47cc878177c4d2aa163d584a5) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add `features.encryption` to `WorkflowMetadata` returned by `getWorkflowMetadata()`

- [#1616](https://github.com/vercel/workflow/pull/1616) [`71d39d2`](https://github.com/vercel/workflow/commit/71d39d2f8d5739c22fb9d777e70d003b07d05987) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Use custom class serialization for `Run` across runtime and workflow VM contexts, and add e2e coverage for `Run` instance boundary roundtrips

- [#1677](https://github.com/vercel/workflow/pull/1677) [`9513a81`](https://github.com/vercel/workflow/commit/9513a8160cc13ac2b3923a0d9500cd80eb477109) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add serialization support for workflow function references

### Patch Changes

- [#1658](https://github.com/vercel/workflow/pull/1658) [`a5c90ce`](https://github.com/vercel/workflow/commit/a5c90cefba01070aa4bc12a696334ee4c1061f92) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Fix community world E2E tests by adding `specVersion` to the World interface so `start()` uses the safe baseline (v2) for worlds that don't declare their supported version

- [#1678](https://github.com/vercel/workflow/pull/1678) [`ea97bd6`](https://github.com/vercel/workflow/commit/ea97bd600711f67649509b21c7af5808fb13479f) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Remove redundant `hc_` prefix from health check correlationId that caused doubled `hc_hc_` in the derived runId and stream name.

- [#942](https://github.com/vercel/workflow/pull/942) [`873b4e2`](https://github.com/vercel/workflow/commit/873b4e2bb451e0a4d28e0a96671c25e1db4932db) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - **BREAKING CHANGE**: Make `getWorld` and `createWorld` asynchronous to support ESM dynamic imports for custom world modules. All callers must now `await getWorld()`.

- Updated dependencies [[`66d49c0`](https://github.com/vercel/workflow/commit/66d49c0db608b034c8fc1b4087a047e0be067b77), [`a5c90ce`](https://github.com/vercel/workflow/commit/a5c90cefba01070aa4bc12a696334ee4c1061f92), [`68cf25e`](https://github.com/vercel/workflow/commit/68cf25e83bdc8bf912fb30cb8f9ba4cb9a30f087), [`66d49c0`](https://github.com/vercel/workflow/commit/66d49c0db608b034c8fc1b4087a047e0be067b77)]:
  - @workflow/world@5.0.0-beta.1
  - @workflow/world-local@5.0.0-beta.1
  - @workflow/world-vercel@5.0.0-beta.1
  - @workflow/errors@5.0.0-beta.0

## 5.0.0-beta.0

### Major Changes

- [#1642](https://github.com/vercel/workflow/pull/1642) [`c5cdfc0`](https://github.com/vercel/workflow/commit/c5cdfc00751c5bef36c4be748d819081b934fbcd) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Initial v5 beta release

### Patch Changes

- Updated dependencies [[`c5cdfc0`](https://github.com/vercel/workflow/commit/c5cdfc00751c5bef36c4be748d819081b934fbcd)]:
  - @workflow/errors@5.0.0-beta.0
  - @workflow/serde@5.0.0-beta.0
  - @workflow/utils@5.0.0-beta.0
  - @workflow/world@5.0.0-beta.0
  - @workflow/world-local@5.0.0-beta.0
  - @workflow/world-vercel@5.0.0-beta.0

## 4.2.0-beta.78

### Patch Changes

- [#1627](https://github.com/vercel/workflow/pull/1627) [`5f138f2`](https://github.com/vercel/workflow/commit/5f138f2ceedcc96c9d043fa36378c4de781ab55b) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Bump specVersion to 3 and gate CBOR queue transport on spec version. Old deployments (specVersion < 3) receive JSON queue messages; new deployments receive CBOR. Handler uses dual transport to deserialize both formats. Fixes replay/reenqueue from dashboard to older deployments.

- [#1629](https://github.com/vercel/workflow/pull/1629) [`a6bcea9`](https://github.com/vercel/workflow/commit/a6bcea9d2827731040cb20f1615c5127530fc310) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - CLI `start` command probes deployment specVersion via health check before choosing queue transport. Health check always uses JSON transport for compatibility with old deployments.

- [#1533](https://github.com/vercel/workflow/pull/1533) [`7e70d18`](https://github.com/vercel/workflow/commit/7e70d1823add7930d6df7f84e1a6a77d888eb851) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Add `streamFlushIntervalMs` option to `Streamer` interface, optional for worlds to allow overwriting the default of 10ms in low-latency environments.

- [#1512](https://github.com/vercel/workflow/pull/1512) [`ba916e1`](https://github.com/vercel/workflow/commit/ba916e1566acc56533e7f5fcebbb8466360e0581) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add `DOMException` to the workflow VM context and add first-class serialization support, preserving `message`, `name`, and derived `code` across serialization boundaries

- [#1618](https://github.com/vercel/workflow/pull/1618) [`c9b3038`](https://github.com/vercel/workflow/commit/c9b30381f4e219fdd67bb3ef358f41697ed8c3e5) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - fix(core): properly propagate stream cancellation on disconnect

- [#1537](https://github.com/vercel/workflow/pull/1537) [`c8dce52`](https://github.com/vercel/workflow/commit/c8dce5260627a2f349618976e8478ce03e656536) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Allow workflow invocation to create run if initial storage call in `start` did not succeed. Send run input through queue to enable this. Allow creating run_created and run_started events together in World, and skip first event list call by returning events directly.

- [#1606](https://github.com/vercel/workflow/pull/1606) [`ab872cc`](https://github.com/vercel/workflow/commit/ab872cc9fb6c24091c8c0eeb0efa7d0cbbdf20d8) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Make registeredSteps a global singleton to protect against module duplication and caching issues

- Updated dependencies [[`5f138f2`](https://github.com/vercel/workflow/commit/5f138f2ceedcc96c9d043fa36378c4de781ab55b), [`7e70d18`](https://github.com/vercel/workflow/commit/7e70d1823add7930d6df7f84e1a6a77d888eb851), [`c8dce52`](https://github.com/vercel/workflow/commit/c8dce5260627a2f349618976e8478ce03e656536), [`5b9eb40`](https://github.com/vercel/workflow/commit/5b9eb406a8e5b778739fd4f49f5b017e0680fa6d)]:
  - @workflow/world-vercel@4.1.0-beta.49
  - @workflow/world@4.1.0-beta.17
  - @workflow/world-local@4.1.0-beta.51
  - @workflow/errors@4.1.0-beta.20

## 4.2.0-beta.77

### Patch Changes

- [#1591](https://github.com/vercel/workflow/pull/1591) [`d8aaf27`](https://github.com/vercel/workflow/commit/d8aaf27c7913a1a44561325c9a08f50b4340100d) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Fix step `contextStorage` global _potentially_ seeing dual-instance issues when bundlers create multiple copies of the module.

- [#1367](https://github.com/vercel/workflow/pull/1367) [`047c01b`](https://github.com/vercel/workflow/commit/047c01bc1545845b4251a58a380e627ef164e6d5) Thanks [@pranaygp](https://github.com/pranaygp)! - Make `start()` return `Run<unknown>` with `unknown[]` args when `deploymentId` is provided, since the deployed workflow version may have different types

- Updated dependencies [[`b30b0dc`](https://github.com/vercel/workflow/commit/b30b0dcab68a8cc37735ea6c1fb8cb4f06efbe8b), [`760ebf1`](https://github.com/vercel/workflow/commit/760ebf161b0382cd430657cd1d172e8861660c30)]:
  - @workflow/world@4.1.0-beta.16
  - @workflow/world-local@4.1.0-beta.50
  - @workflow/world-vercel@4.1.0-beta.48
  - @workflow/errors@4.1.0-beta.20

## 4.2.0-beta.76

### Patch Changes

- Updated dependencies [[`ef2218a`](https://github.com/vercel/workflow/commit/ef2218ab22310afa04e4e1709906a86969126e52)]:
  - @workflow/world-local@4.1.0-beta.49
  - @workflow/world-vercel@4.1.0-beta.47

## 4.2.0-beta.75

### Patch Changes

- [#1569](https://github.com/vercel/workflow/pull/1569) [`a98f8de`](https://github.com/vercel/workflow/commit/a98f8de53f1af222cccea6d091b68d544957b4e3) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Combine initial run fetch, event fetch, and run_started event creation

- [#1572](https://github.com/vercel/workflow/pull/1572) [`d38114b`](https://github.com/vercel/workflow/commit/d38114bff1c0a786e103b3da8c2d9afc93b41fbe) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Fix `resumeHook()`/`resumeWebhook()` failing on workflow runs from pre-encryption deployments by checking the target run's `workflowCoreVersion` capabilities before encoding the payload

- [#1567](https://github.com/vercel/workflow/pull/1567) [`6dc1b78`](https://github.com/vercel/workflow/commit/6dc1b785822af5c1dc3b4a2a9b1dcb7f626cf5ff) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Increase flow route limit to max fluid duration and fail run if a single replay takes too long

- Updated dependencies [[`a98f8de`](https://github.com/vercel/workflow/commit/a98f8de53f1af222cccea6d091b68d544957b4e3), [`6dc1b78`](https://github.com/vercel/workflow/commit/6dc1b785822af5c1dc3b4a2a9b1dcb7f626cf5ff), [`329cdb3`](https://github.com/vercel/workflow/commit/329cdb3e1b55e3a2e8eb6b5befff598d7184bd78)]:
  - @workflow/world@4.1.0-beta.15
  - @workflow/world-local@4.1.0-beta.48
  - @workflow/errors@4.1.0-beta.20
  - @workflow/world-vercel@4.1.0-beta.46

## 4.2.0-beta.74

### Patch Changes

- [#1546](https://github.com/vercel/workflow/pull/1546) [`62ff600`](https://github.com/vercel/workflow/commit/62ff6004f6f5c1b7b93099470a0097d8a81a42ee) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Remove `Buffer` global from workflow VM context

- [#1547](https://github.com/vercel/workflow/pull/1547) [`4f646e3`](https://github.com/vercel/workflow/commit/4f646e3d58d27a5777922519a72e352814a7ef12) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Polyfill TC39 `Uint8Array` base64/hex methods in workflow VM context

- Updated dependencies [[`bd1f7e4`](https://github.com/vercel/workflow/commit/bd1f7e4b4c45750f9b8a3f37057076f2e69a5c07)]:
  - @workflow/world-local@4.1.0-beta.47

## 4.2.0-beta.73

### Patch Changes

- [#1520](https://github.com/vercel/workflow/pull/1520) [`8e7083b`](https://github.com/vercel/workflow/commit/8e7083b327cc727c9a4363030be8c375f9863016) Thanks [@pranaygp](https://github.com/pranaygp)! - Add `btoa`, `atob`, and `Buffer` globals to workflow VM context for base64 encoding/decoding

- [#1523](https://github.com/vercel/workflow/pull/1523) [`d1391e1`](https://github.com/vercel/workflow/commit/d1391e1fd9a553d87ae467ba2babdc96545d5d36) Thanks [@pranaygp](https://github.com/pranaygp)! - Fix race condition allowing duplicate `hook_disposed` events for the same hook

- [#1518](https://github.com/vercel/workflow/pull/1518) [`c739b99`](https://github.com/vercel/workflow/commit/c739b995814cbc3c67092faa481e6d3d0cabfe50) Thanks [@ceolinwill](https://github.com/ceolinwill)! - Fix `getWritable()` in step functions to resolve on lock release instead of requiring stream close, preventing Vercel function timeouts

- Updated dependencies [[`d1391e1`](https://github.com/vercel/workflow/commit/d1391e1fd9a553d87ae467ba2babdc96545d5d36)]:
  - @workflow/world-local@4.1.0-beta.46

## 4.2.0-beta.72

### Patch Changes

- [#1448](https://github.com/vercel/workflow/pull/1448) [`73a851a`](https://github.com/vercel/workflow/commit/73a851ada6a4d46ae8f022ef243ebf4ee3de2ad8) Thanks [@pranaygp](https://github.com/pranaygp)! - Add `HookConflictError` to `@workflow/errors` and use it for hook token conflicts instead of `WorkflowRuntimeError`

- [#1340](https://github.com/vercel/workflow/pull/1340) [`84599b7`](https://github.com/vercel/workflow/commit/84599b7ec5c19207082523609f1b3508a1a18bd7) Thanks [@pranaygp](https://github.com/pranaygp)! - Add error code classification (`USER_ERROR`, `RUNTIME_ERROR`) to `run_failed` events, improve queue and schema validation error logging

- [#1452](https://github.com/vercel/workflow/pull/1452) [`672d919`](https://github.com/vercel/workflow/commit/672d9195a475a110a64dbaa7c5c87a24f244c11a) Thanks [@pranaygp](https://github.com/pranaygp)! - Fix workflow/step not found errors to fail gracefully instead of causing infinite queue retries

- [#1344](https://github.com/vercel/workflow/pull/1344) [`beccbc4`](https://github.com/vercel/workflow/commit/beccbc4298f434a4ffb9563c4f832f2230016f40) Thanks [@pranaygp](https://github.com/pranaygp)! - Remove VQS maxDeliveries cap and enforce max delivery limit in workflow/step handlers with graceful failure

- [#1460](https://github.com/vercel/workflow/pull/1460) [`78f1b0e`](https://github.com/vercel/workflow/commit/78f1b0e19f2ac1a621020bc9fa5dec778f3b0fd9) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Support negative `startIndex` for streaming (e.g. `-3` reads last 3 chunks)

- [#1438](https://github.com/vercel/workflow/pull/1438) [`da6adf7`](https://github.com/vercel/workflow/commit/da6adf7798efa38cfbe7d30209102c11cc7643c4) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Improve display when run data has expired

- [#1342](https://github.com/vercel/workflow/pull/1342) [`aee035f`](https://github.com/vercel/workflow/commit/aee035f94483ef3b842bb557e8c5b167dd0536c4) Thanks [@pranaygp](https://github.com/pranaygp)! - Replace HTTP status code checks with semantic error types (EntityConflictError, RunExpiredError, ThrottleError, TooEarlyError). **BREAKING CHANGE**: `WorkflowAPIError` renamed to `WorkflowWorldError`.

- [#1470](https://github.com/vercel/workflow/pull/1470) [`01bbe66`](https://github.com/vercel/workflow/commit/01bbe66d5a60d50d71f5b1c82b002ca7fc6f8e0b) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Add `getStreamChunks()` and `getStreamInfo()` to the Streamer interface, and `getTailIndex()` to the readable stream returned by `run.getReadable()`. `WorkflowChatTransport` now reads the `x-workflow-stream-tail-index` response header to resolve negative `initialStartIndex` values into absolute positions, fixing reconnection retries after a disconnect.

- [#1446](https://github.com/vercel/workflow/pull/1446) [`2b07294`](https://github.com/vercel/workflow/commit/2b072943134e8655afe8b3c2dfe535307b7a1a8b) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Ensure open stream flush is await-able in pendingOps

- Updated dependencies [[`73a851a`](https://github.com/vercel/workflow/commit/73a851ada6a4d46ae8f022ef243ebf4ee3de2ad8), [`84599b7`](https://github.com/vercel/workflow/commit/84599b7ec5c19207082523609f1b3508a1a18bd7), [`fdbe853`](https://github.com/vercel/workflow/commit/fdbe853531ed07c6844dd08fa76a3c8b86f13db5), [`2ef33d2`](https://github.com/vercel/workflow/commit/2ef33d2828ac06debf04ad9cc239d70fea6a8093), [`d428d66`](https://github.com/vercel/workflow/commit/d428d66441319e612b72f9b7cf430abcf45a5ecf), [`672d919`](https://github.com/vercel/workflow/commit/672d9195a475a110a64dbaa7c5c87a24f244c11a), [`beccbc4`](https://github.com/vercel/workflow/commit/beccbc4298f434a4ffb9563c4f832f2230016f40), [`78f1b0e`](https://github.com/vercel/workflow/commit/78f1b0e19f2ac1a621020bc9fa5dec778f3b0fd9), [`aee035f`](https://github.com/vercel/workflow/commit/aee035f94483ef3b842bb557e8c5b167dd0536c4), [`741661b`](https://github.com/vercel/workflow/commit/741661b0bb07d2e3d3be1c51ed905468f1e8b93f), [`01bbe66`](https://github.com/vercel/workflow/commit/01bbe66d5a60d50d71f5b1c82b002ca7fc6f8e0b)]:
  - @workflow/errors@4.1.0-beta.19
  - @workflow/world-local@4.1.0-beta.45
  - @workflow/world-vercel@4.1.0-beta.45
  - @workflow/world@4.1.0-beta.14

## 4.2.0-beta.71

### Patch Changes

- [#1409](https://github.com/vercel/workflow/pull/1409) [`97e4384`](https://github.com/vercel/workflow/commit/97e43846f000f8ef0ea2f237a5c4cc696423e0f0) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Remove `@deprecated` tag from `deploymentId` in `StartOptions`

- [#1413](https://github.com/vercel/workflow/pull/1413) [`dcb0761`](https://github.com/vercel/workflow/commit/dcb07617be46b83ce74a4932bf121b20cd3de597) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Refactor builtin step functions to use `this` value serialization instead of explicit parameter passing. Remove unused duplicate builtins file from `@workflow/core`.

- [#1396](https://github.com/vercel/workflow/pull/1396) [`2f0772d`](https://github.com/vercel/workflow/commit/2f0772d3df4983de2f6618054379a496ade4ec5a) Thanks [@karthikscale3](https://github.com/karthikscale3)! - Track Vercel request IDs (`x-vercel-id`) on all workflow events for correlating request logs with workflow executions

- [#1400](https://github.com/vercel/workflow/pull/1400) [`a2c0c7e`](https://github.com/vercel/workflow/commit/a2c0c7e6d9d7349bd49aac6e6ea072c68efb7620) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Seed lazy workflow file discovery in NextJS. Require workflow definitions to be in manifest for Vercel environments.

- [#1418](https://github.com/vercel/workflow/pull/1418) [`2cc42cb`](https://github.com/vercel/workflow/commit/2cc42cb8a934532d9ce5b05185322a2f9ce76024) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Don't fail to queue on 409 responses

- [#1402](https://github.com/vercel/workflow/pull/1402) [`f52afe7`](https://github.com/vercel/workflow/commit/f52afe77fffb981dd8812b84b39c2ecab2288f43) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Reduce log severity for 409/429 logs from `warn` to `info`, as they can't be meaningfully acted on by the consumer.

- Updated dependencies [[`02ea057`](https://github.com/vercel/workflow/commit/02ea0574422b342e6a467de073e003b73e099830), [`d6e8727`](https://github.com/vercel/workflow/commit/d6e8727a948ce60d15af635763239d8321cd7cee), [`2f0772d`](https://github.com/vercel/workflow/commit/2f0772d3df4983de2f6618054379a496ade4ec5a), [`0f07403`](https://github.com/vercel/workflow/commit/0f074030a408078e7db0ae0e494f64125d7444e4), [`e902980`](https://github.com/vercel/workflow/commit/e9029807733d6a7dba76626ae61bd751e9a18fbe), [`94c14c7`](https://github.com/vercel/workflow/commit/94c14c746b3218d13a5e2a7936c8cef505e7be08)]:
  - @workflow/world-local@4.1.0-beta.44
  - @workflow/world-vercel@4.1.0-beta.44
  - @workflow/world@4.1.0-beta.13
  - @workflow/errors@4.1.0-beta.18

## 4.2.0-beta.70

### Patch Changes

- [#1339](https://github.com/vercel/workflow/pull/1339) [`7df1385`](https://github.com/vercel/workflow/commit/7df13854f85529929ff1187fe831f4dbc51b9121) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Separate infrastructure vs user code error handling in workflow and step runtimes so transient network errors (ECONNRESET, etc.) propagate to the queue for retry instead of incorrectly marking runs as failed

- [#1345](https://github.com/vercel/workflow/pull/1345) [`58e67ce`](https://github.com/vercel/workflow/commit/58e67ce11bd69b982214e2734363fa7fd252f5f6) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Suppress stale `WORKFLOW_VERCEL_*` env var warning when running outside Vercel serverless (e.g. CLI, web observability app)

- Updated dependencies [[`9feebee`](https://github.com/vercel/workflow/commit/9feebee15c7c35843b99254b23a2f7743ea3f8c6)]:
  - @workflow/world-local@4.1.0-beta.43

## 4.2.0-beta.69

### Patch Changes

- [#1317](https://github.com/vercel/workflow/pull/1317) [`825417a`](https://github.com/vercel/workflow/commit/825417acbaf7f721259427ecf4b7bc2a0e5cbef7) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Support `deploymentId: 'latest'` in `start()` options to automatically resolve the most recent deployment ID for the current environment

- [#1336](https://github.com/vercel/workflow/pull/1336) [`fb5a500`](https://github.com/vercel/workflow/commit/fb5a500eadba80efdef75e3ccf6e85e957820f38) Thanks [@pranaygp](https://github.com/pranaygp)! - Add `exists` getter to `Run` class for checking if a workflow run exists without throwing

- Updated dependencies [[`825417a`](https://github.com/vercel/workflow/commit/825417acbaf7f721259427ecf4b7bc2a0e5cbef7), [`825417a`](https://github.com/vercel/workflow/commit/825417acbaf7f721259427ecf4b7bc2a0e5cbef7), [`3648109`](https://github.com/vercel/workflow/commit/3648109861f1fbfe24101936dc35c9a36650b7e2), [`d5bc418`](https://github.com/vercel/workflow/commit/d5bc418816748ab2b5109ca7b082f3be427c326b)]:
  - @workflow/world-vercel@4.1.0-beta.43
  - @workflow/world@4.1.0-beta.12
  - @workflow/world-local@4.1.0-beta.42
  - @workflow/errors@4.1.0-beta.18

## 4.2.0-beta.68

### Patch Changes

- [#1304](https://github.com/vercel/workflow/pull/1304) [`83dbd46`](https://github.com/vercel/workflow/commit/83dbd46456a8dbfc89efd87895929cbb813feda3) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Stop reading `WORKFLOW_VERCEL_*` env vars at runtime to prevent unintended proxy routing

- [#1318](https://github.com/vercel/workflow/pull/1318) [`854a25f`](https://github.com/vercel/workflow/commit/854a25f9103f5f3a5769dec6e3e5c6b98ed119b0) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Fix `start()` not encrypting initial workflow input in external contexts (e2e tests, CLI). The resolved `deploymentId` was not being passed to `getEncryptionKeyForRun`, causing it to silently skip encryption when `deploymentId` was inferred from the environment rather than explicitly provided in options.

- Updated dependencies [[`9781afb`](https://github.com/vercel/workflow/commit/9781afb490b252f5656e5d48c61c038c3aef794f), [`4a6ddd8`](https://github.com/vercel/workflow/commit/4a6ddd82c0fc1b3768f3a10befad77f43e81036e), [`d842ce1`](https://github.com/vercel/workflow/commit/d842ce1c435049805233cf218aa9ce07d9cab130)]:
  - @workflow/world-vercel@4.1.0-beta.42
  - @workflow/world-local@4.1.0-beta.41

## 4.2.0-beta.67

### Patch Changes

- [#1294](https://github.com/vercel/workflow/pull/1294) [`c71befe`](https://github.com/vercel/workflow/commit/c71befe8ec73765e67b7f2e0627251643ab245d4) Thanks [@pranaygp](https://github.com/pranaygp)! - Fix premature workflow suspension when hooks have buffered payloads and a concurrent sleep or incomplete step is pending

- [#1285](https://github.com/vercel/workflow/pull/1285) [`36a901d`](https://github.com/vercel/workflow/commit/36a901d2d2f2ba37ec024073a7dd39a094b9e9c0) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add `workflowName` to `getWorkflowMetadata()` and `stepName` to `getStepMetadata()`

- Updated dependencies [[`d8daa2a`](https://github.com/vercel/workflow/commit/d8daa2a9a95e2d01a4e6fee4e8dde51d82db762d)]:
  - @workflow/world@4.1.0-beta.11
  - @workflow/world-local@4.1.0-beta.40
  - @workflow/world-vercel@4.1.0-beta.41
  - @workflow/errors@4.1.0-beta.18

## 4.2.0-beta.66

### Patch Changes

- [#1290](https://github.com/vercel/workflow/pull/1290) [`8b5a388`](https://github.com/vercel/workflow/commit/8b5a388a9451d7c7460481f0889da5037bd90893) Thanks [@pranaygp](https://github.com/pranaygp)! - Support `timeoutSeconds: 0` for immediate re-enqueue without arbitrary delay

- [#1283](https://github.com/vercel/workflow/pull/1283) [`dff00c9`](https://github.com/vercel/workflow/commit/dff00c94008f60cbfb4a398f2b98101d80ee8377) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Avoid port inference in Vercel environment

- Updated dependencies [[`8b5a388`](https://github.com/vercel/workflow/commit/8b5a388a9451d7c7460481f0889da5037bd90893)]:
  - @workflow/world-local@4.1.0-beta.39
  - @workflow/world-vercel@4.1.0-beta.40

## 4.2.0-beta.65

### Patch Changes

- Updated dependencies [[`456c1aa`](https://github.com/vercel/workflow/commit/456c1aa455d9d391a954b25e3d86ee9b06ad2f30), [`11dcb64`](https://github.com/vercel/workflow/commit/11dcb646d33e7a2b251d9388c2c8ecdd6aca73f7)]:
  - @workflow/world-local@4.1.0-beta.38
  - @workflow/world@4.1.0-beta.10
  - @workflow/world-vercel@4.1.0-beta.39
  - @workflow/errors@4.1.0-beta.18

## 4.2.0-beta.64

### Minor Changes

- [`30e24d4`](https://github.com/vercel/workflow/commit/30e24d441e735635ffa4522198e6905d0e51e175) Thanks [@pranaygp](https://github.com/pranaygp)! - **BREAKING CHANGE**: `createWebhook()` no longer accepts a `token` option. Webhook tokens are always randomly generated to prevent unauthorized access to the public webhook endpoint. Use `createHook()` with `resumeHook()` for deterministic server-side token patterns.

### Patch Changes

- [#1270](https://github.com/vercel/workflow/pull/1270) [`adfe8b6`](https://github.com/vercel/workflow/commit/adfe8b6b1123ce581aa9572bae91b8d7f9cdc53d) Thanks [@pranaygp](https://github.com/pranaygp)! - Add `HookNotFoundError` to `@workflow/errors` and adopt it across all world backends

- [#1270](https://github.com/vercel/workflow/pull/1270) [`adfe8b6`](https://github.com/vercel/workflow/commit/adfe8b6b1123ce581aa9572bae91b8d7f9cdc53d) Thanks [@pranaygp](https://github.com/pranaygp)! - Prevent hooks from being resumed via the public webhook endpoint by default. Add `isWebhook` option to `createHook()` to opt-in to public resumption. `createWebhook()` always sets `isWebhook: true`.

- [#1251](https://github.com/vercel/workflow/pull/1251) [`7618ac3`](https://github.com/vercel/workflow/commit/7618ac36c203d04e39513953e3b22a13b0c70829) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Wire AES-GCM encryption into serialization layer with stream support

- [#1246](https://github.com/vercel/workflow/pull/1246) [`860531d`](https://github.com/vercel/workflow/commit/860531d182d74547acd12784cb825bb41c1a9342) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Route all event-driven promise resolutions through a sequential queue to ensure deterministic ordering

- [#1254](https://github.com/vercel/workflow/pull/1254) [`60bc9d5`](https://github.com/vercel/workflow/commit/60bc9d5cb1022e169266884f4bcdd0fb99c45679) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Fix false positive unconsumed event detection during async deserialization and cross-VM promise propagation

- [#1256](https://github.com/vercel/workflow/pull/1256) [`bbe40ff`](https://github.com/vercel/workflow/commit/bbe40ff00a5e372b040aec8fc7640c54d08c5636) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add encryption-aware o11y for CLI and web UI

- [#1269](https://github.com/vercel/workflow/pull/1269) [`a7ae7e9`](https://github.com/vercel/workflow/commit/a7ae7e9a612905c911a59b631d62856d31333aeb) Thanks [@pranaygp](https://github.com/pranaygp)! - Improve deterministic VM context seed derivation to incorporate additional run metadata

- Updated dependencies [[`adfe8b6`](https://github.com/vercel/workflow/commit/adfe8b6b1123ce581aa9572bae91b8d7f9cdc53d), [`adfe8b6`](https://github.com/vercel/workflow/commit/adfe8b6b1123ce581aa9572bae91b8d7f9cdc53d), [`02f706f`](https://github.com/vercel/workflow/commit/02f706fb99d2ffa3f862698092d17cedbdb8ba02)]:
  - @workflow/errors@4.1.0-beta.18
  - @workflow/world-local@4.1.0-beta.37
  - @workflow/world-vercel@4.1.0-beta.38
  - @workflow/world@4.1.0-beta.9

## 4.1.0-beta.63

### Patch Changes

- [#1232](https://github.com/vercel/workflow/pull/1232) [`4ab4412`](https://github.com/vercel/workflow/commit/4ab4412ae6f4a64eb29fcb0e445f0b3314aa3b9b) Thanks [@pranaygp](https://github.com/pranaygp)! - Add `Run.wakeUp()` method to programmatically interrupt pending `sleep()` calls

- [#1230](https://github.com/vercel/workflow/pull/1230) [`a9fea91`](https://github.com/vercel/workflow/commit/a9fea9132ef3797dbda7683c36cc86ff2bd82f1f) Thanks [@ijjk](https://github.com/ijjk)! - Fix deferred build mode for Next.js

- Updated dependencies [[`2b1c2bd`](https://github.com/vercel/workflow/commit/2b1c2bd8e6b384334fbeb7ede8f517a5ca683716)]:
  - @workflow/world-vercel@4.1.0-beta.37

## 4.1.0-beta.62

### Patch Changes

- [#1172](https://github.com/vercel/workflow/pull/1172) [`6f2cbcd`](https://github.com/vercel/workflow/commit/6f2cbcda9df55809f2dab15a05b0b72a78095439) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Fix custom Error subclass serialization precedence: move Instance reducer before Error reducer so that Error subclasses with WORKFLOW_SERIALIZE are serialized using custom class serialization instead of the generic Error serialization

- [#1181](https://github.com/vercel/workflow/pull/1181) [`02681dc`](https://github.com/vercel/workflow/commit/02681dce4a504ff236c81a1ee976d2b04d1a5774) Thanks [@pranaygp](https://github.com/pranaygp)! - Add `hook.dispose()` method to explicitly release hook tokens for reuse by other workflows while the current workflow is still running

- [#1185](https://github.com/vercel/workflow/pull/1185) [`028a828`](https://github.com/vercel/workflow/commit/028a828de113f8b07f9bb70d91f75e97162ab37d) Thanks [@pranaygp](https://github.com/pranaygp)! - Warn when workflow completes with uncommitted operations (unawaited steps, hooks, or sleeps)

- [#1217](https://github.com/vercel/workflow/pull/1217) [`e55c636`](https://github.com/vercel/workflow/commit/e55c63678b15b6687cc77efca705ee9fb40fabc3) Thanks [@pranaygp](https://github.com/pranaygp)! - Upgrade dependencies across all packages

- Updated dependencies [[`1cfb8b1`](https://github.com/vercel/workflow/commit/1cfb8b12e7d40e372d6e223add1518cd62fa0b5f), [`274ea8b`](https://github.com/vercel/workflow/commit/274ea8b5720c03d564b567edb3fdeb97a6db2c09), [`f3b2e08`](https://github.com/vercel/workflow/commit/f3b2e08adbb259670445bba7cea79cfd25c8370b), [`e55c636`](https://github.com/vercel/workflow/commit/e55c63678b15b6687cc77efca705ee9fb40fabc3)]:
  - @workflow/world-vercel@4.1.0-beta.36
  - @workflow/world-local@4.1.0-beta.36
  - @workflow/utils@4.1.0-beta.13
  - @workflow/world@4.1.0-beta.8
  - @workflow/errors@4.1.0-beta.17

## 4.1.0-beta.61

### Patch Changes

- [#1135](https://github.com/vercel/workflow/pull/1135) [`f5ea16f`](https://github.com/vercel/workflow/commit/f5ea16fbf5ba046e0e7a6e7ef95d6305abfd1768) Thanks [@btsmithnz](https://github.com/btsmithnz)! - Update `devalue` to v5.6.3 to resolve security alerts

- [#1178](https://github.com/vercel/workflow/pull/1178) [`70223a9`](https://github.com/vercel/workflow/commit/70223a9091494ba1db56784e29e5bc92c78a89e0) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Don't enforce client-side generated runId in `start()` for `v1Compat`

- [#1164](https://github.com/vercel/workflow/pull/1164) [`d99ca9c`](https://github.com/vercel/workflow/commit/d99ca9cfed4fafd43853f89f8a4939ed3d240e20) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Fix `FatalError` instance serialization

- Updated dependencies [[`b224521`](https://github.com/vercel/workflow/commit/b224521cb09c6741423783140c50148b0c98d227), [`49d1b6d`](https://github.com/vercel/workflow/commit/49d1b6d57ea6b9283eef7158dcd4881caa18091f), [`e1a2f47`](https://github.com/vercel/workflow/commit/e1a2f475aa3258ee9e36e0694f73dbbe72b49fbe), [`c614456`](https://github.com/vercel/workflow/commit/c6144564eab0168bbb00350839c04f5f009dcd8e), [`b06e491`](https://github.com/vercel/workflow/commit/b06e491a4769724435afff66724ac9e275fe11df)]:
  - @workflow/world-vercel@4.1.0-beta.35
  - @workflow/world@4.1.0-beta.7
  - @workflow/errors@4.1.0-beta.16
  - @workflow/world-local@4.1.0-beta.35

## 4.1.0-beta.60

### Patch Changes

- [#1147](https://github.com/vercel/workflow/pull/1147) [`c1cd9a3`](https://github.com/vercel/workflow/commit/c1cd9a3bc7a0ef953d588c8fe4f21a32f80711b3) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Handle 410s gracefully for run completion/failure

## 4.1.0-beta.59

### Patch Changes

- [#1120](https://github.com/vercel/workflow/pull/1120) [`c75de97`](https://github.com/vercel/workflow/commit/c75de973fd41d2a1d0391d965b61210a9fb7c86c) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Handle 409 errors gracefully for step_completed, step_failed, and step_retrying events

- [#956](https://github.com/vercel/workflow/pull/956) [`b65bb07`](https://github.com/vercel/workflow/commit/b65bb072b540e9e5fb6bc3f72c4132667cc60277) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add browser-compatible AES-256-GCM encryption module with `importKey`, `encrypt`, and `decrypt` functions; update all runtime callers to resolve `CryptoKey` once per run via `importKey()`

- Updated dependencies [[`b65bb07`](https://github.com/vercel/workflow/commit/b65bb072b540e9e5fb6bc3f72c4132667cc60277), [`b65bb07`](https://github.com/vercel/workflow/commit/b65bb072b540e9e5fb6bc3f72c4132667cc60277)]:
  - @workflow/world-vercel@4.1.0-beta.34
  - @workflow/world@4.1.0-beta.6
  - @workflow/errors@4.1.0-beta.16
  - @workflow/world-local@4.1.0-beta.34

## 4.1.0-beta.58

### Patch Changes

- [#978](https://github.com/vercel/workflow/pull/978) [`0d5323c`](https://github.com/vercel/workflow/commit/0d5323c0a7e760f1fa3741cf249c19f59e9ddfbe) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Refactor serialization code to be asynchronous

- [#1098](https://github.com/vercel/workflow/pull/1098) [`7046610`](https://github.com/vercel/workflow/commit/704661078f6d6065f9b5dcd28c0b98ae91034143) Thanks [@pranaygp](https://github.com/pranaygp)! - Auto-inject `x-workflow-run-id` and `x-workflow-step-id` VQS headers from queue payload in `world-vercel`

- [#1055](https://github.com/vercel/workflow/pull/1055) [`c2b4fe9`](https://github.com/vercel/workflow/commit/c2b4fe9906fd0845fef646669034cd203d97a18d) Thanks [@pranaygp](https://github.com/pranaygp)! - Detect and fatal error on orphaned/invalid events in the event log instead of silently hanging

- [#979](https://github.com/vercel/workflow/pull/979) [`6e72b29`](https://github.com/vercel/workflow/commit/6e72b295e71c1a9e0a91dbe1137eca7b88227e1f) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add `World.getEncryptionKeyForRun()` and thread encryption key through serialization layer

- [#999](https://github.com/vercel/workflow/pull/999) [`ea3254e`](https://github.com/vercel/workflow/commit/ea3254e7ce28cef6b9b829ac7ad379921dd41ed9) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Separate project ID and project name into distinct env vars (WORKFLOW_VERCEL_PROJECT and WORKFLOW_VERCEL_PROJECT_NAME)

- [#1031](https://github.com/vercel/workflow/pull/1031) [`1c11573`](https://github.com/vercel/workflow/commit/1c1157340d88c60c7c80c0789c111050b809ab77) Thanks [@karthikscale3](https://github.com/karthikscale3)! - Refactor and enhance web-shared observability UI components and update builders base behavior.

- [#1051](https://github.com/vercel/workflow/pull/1051) [`9f77380`](https://github.com/vercel/workflow/commit/9f773804937cf94fc65a2141c4a45b429771a5cb) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Fix 429 backoff for workflow runtime API calls

- [#1118](https://github.com/vercel/workflow/pull/1118) [`852e3f1`](https://github.com/vercel/workflow/commit/852e3f1788f7a9aff638b322af4c8b1a7135c17e) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Do not re-throw error when multiple workflow invocations race to complete the workflow

- [#1057](https://github.com/vercel/workflow/pull/1057) [`5e06a7c`](https://github.com/vercel/workflow/commit/5e06a7c8332042a4835fa0e469e1031fec742668) Thanks [@pranaygp](https://github.com/pranaygp)! - Materialize waits as entities to prevent duplicate wait_completed events
  - `@workflow/core`: Handle 409 conflict gracefully when creating wait_completed events, preventing crashes when multiple concurrent invocations race to complete the same wait
  - `@workflow/world`: Add `Wait` type, `WaitSchema`, and `WaitStatusSchema` exports; add optional `wait` field to `EventResult`
  - `@workflow/world-local`: Materialize wait entities on wait_created/wait_completed with duplicate detection; clean up waits on terminal run states
  - `@workflow/world-postgres`: Add `workflow_waits` table with `wait_status` enum; materialize wait entities with conditional writes for duplicate prevention; clean up waits on terminal run states

- Updated dependencies [[`7046610`](https://github.com/vercel/workflow/commit/704661078f6d6065f9b5dcd28c0b98ae91034143), [`c2b4fe9`](https://github.com/vercel/workflow/commit/c2b4fe9906fd0845fef646669034cd203d97a18d), [`6e72b29`](https://github.com/vercel/workflow/commit/6e72b295e71c1a9e0a91dbe1137eca7b88227e1f), [`ea3254e`](https://github.com/vercel/workflow/commit/ea3254e7ce28cef6b9b829ac7ad379921dd41ed9), [`29347b7`](https://github.com/vercel/workflow/commit/29347b79eae8181d02ed1e52183983adc56425fd), [`5e06a7c`](https://github.com/vercel/workflow/commit/5e06a7c8332042a4835fa0e469e1031fec742668), [`5487983`](https://github.com/vercel/workflow/commit/54879835f390299f9249523e0488bbdca708fb68), [`5487983`](https://github.com/vercel/workflow/commit/54879835f390299f9249523e0488bbdca708fb68)]:
  - @workflow/world-vercel@4.1.0-beta.33
  - @workflow/errors@4.1.0-beta.16
  - @workflow/world@4.1.0-beta.5
  - @workflow/world-local@4.1.0-beta.33

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
