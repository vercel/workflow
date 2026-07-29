# @workflow/core

## 4.7.0

### Minor Changes

- [#3079](https://github.com/vercel/workflow/pull/3079) [`12e4ef7`](https://github.com/vercel/workflow/commit/12e4ef7ea1777a0af1d69db7cf069a6a5da131c7) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Add an optimistic-concurrency guard for event creation (on by default; opt out with `WORKFLOW_PRECONDITION_GUARD=0`): replay-context event creations send a `stateUpdatedAt` snapshot timestamp, and the runtime reloads the event log and retries (then falls back to a fresh re-invocation) when the backend reports a newer out-of-band event with a 412 `PreconditionFailedError`. Backends without guard support ignore the snapshot, so this is backward-compatible and fails open.

### Patch Changes

- Updated dependencies [[`12e4ef7`](https://github.com/vercel/workflow/commit/12e4ef7ea1777a0af1d69db7cf069a6a5da131c7), [`9d8b293`](https://github.com/vercel/workflow/commit/9d8b293f88205ed7b1b343a947e765670da317e3)]:
  - @workflow/world-vercel@4.6.0
  - @workflow/world@4.3.0
  - @workflow/errors@4.2.0
  - @workflow/world-local@4.2.3

## 4.6.2

## 4.6.1

### Patch Changes

- [#2996](https://github.com/vercel/workflow/pull/2996) [`0422a0e`](https://github.com/vercel/workflow/commit/0422a0e51b3299bbd8570e0055419659b8ba3fe1) Thanks [@joeyhotz](https://github.com/joeyhotz)! - Cache self-hosted step port discovery per process.

- [#2687](https://github.com/vercel/workflow/pull/2687) [`b1d1a06`](https://github.com/vercel/workflow/commit/b1d1a066a5710fbd5f97b69ae4dd8a4d892b4d57) Thanks [@Osamaali313](https://github.com/Osamaali313)! - Fix `extractStreamIds` overflowing the stack on circular references

- [#2732](https://github.com/vercel/workflow/pull/2732) [`2213c91`](https://github.com/vercel/workflow/commit/2213c91731f6d47373f4ba4c516c39ec2cc0fa94) Thanks [@NathanColosimo](https://github.com/NathanColosimo)! - Respect framework base paths when routing workflow traffic and expose health checks on generated Next.js workflow routes.

- Updated dependencies [[`aac6ea5`](https://github.com/vercel/workflow/commit/aac6ea53ecb1a281b187652fc4bb7db6596f5d4f), [`2213c91`](https://github.com/vercel/workflow/commit/2213c91731f6d47373f4ba4c516c39ec2cc0fa94), [`7c0266f`](https://github.com/vercel/workflow/commit/7c0266f193065a045e2b36b3072b1dc1d08c07fb), [`8eb110c`](https://github.com/vercel/workflow/commit/8eb110ca2ec0923ad21d51e745925da74c9f0284)]:
  - @workflow/world-vercel@4.5.1
  - @workflow/utils@4.1.4
  - @workflow/world-local@4.2.2
  - @workflow/errors@4.1.5

## 4.6.0

### Minor Changes

- [#1853](https://github.com/vercel/workflow/pull/1853) [`f2ad726`](https://github.com/vercel/workflow/commit/f2ad7261b14dd64085c80584b9d472019414b512) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Add wire-level framing for byte streams (`type: 'bytes'`) so consumers can identify chunk boundaries — a prerequisite for transparent auto-reconnect.

### Patch Changes

- [#2397](https://github.com/vercel/workflow/pull/2397) [`20a6d73`](https://github.com/vercel/workflow/commit/20a6d73a0aa03b4b2f7318d97e12a5e7818c67d9) Thanks [@pranaygp](https://github.com/pranaygp)! - `start({ deploymentId: 'latest' })` is now a no-op in Worlds that don't support atomic deployments (local dev, Postgres) instead of throwing — it logs a warning and targets the current deployment, so workflows that use `'latest'` on Vercel still run locally.

- [#2473](https://github.com/vercel/workflow/pull/2473) [`015452a`](https://github.com/vercel/workflow/commit/015452a70c52044635d24a134b7b984b6d2e1142) Thanks [@pranaygp](https://github.com/pranaygp)! - Drain consecutively consumable replay events in a single synchronous pass instead of one `process.nextTick` per event, removing O(N) macrotask hops from replay.

- [#2768](https://github.com/vercel/workflow/pull/2768) [`d0e4191`](https://github.com/vercel/workflow/commit/d0e4191b7e4dd4122cc0fdcb123de9b36b9c0237) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Correct the byte-stream framing capability cutoff so framed byte streams are never written to deployments that cannot decode them

- [#2522](https://github.com/vercel/workflow/pull/2522) [`5a4c6cf`](https://github.com/vercel/workflow/commit/5a4c6cff3ec52038a417cb68bc720bfa15f090e0) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Cache the local dev server port per process so workflow replays no longer re-run OS port discovery (which spawns `lsof` on macOS, ~60ms) on every replay.

- [#2511](https://github.com/vercel/workflow/pull/2511) [`db8a2c4`](https://github.com/vercel/workflow/commit/db8a2c49820530f7a331bb4c1f0a803e03547831) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Emit `workflowName` on per-step events (`step_created`, `step_completed`) so Worlds can access it without additional queries

- [#2471](https://github.com/vercel/workflow/pull/2471) [`170ea96`](https://github.com/vercel/workflow/commit/170ea9659a2b9c26e611bab8bb5131f9c6cdc14d) Thanks [@pranaygp](https://github.com/pranaygp)! - Cache the compiled workflow-bundle `vm.Script` per process so replays reuse the compiled bundle instead of re-parsing it on every iteration.

- [#2472](https://github.com/vercel/workflow/pull/2472) [`0a5e2aa`](https://github.com/vercel/workflow/commit/0a5e2aa247bc8e4e45d389a2af839110723ce863) Thanks [@pranaygp](https://github.com/pranaygp)! - Memoize hydrated step return values across inline replay iterations, turning the per-invocation step-result decrypt+parse cost from O(N²) to O(N) for sequential workflows. Only primitive results are cached, so deterministic replay is preserved.

- [#2565](https://github.com/vercel/workflow/pull/2565) [`a4dd59b`](https://github.com/vercel/workflow/commit/a4dd59be8c023dad2c173ad4cf1ed565ced34c56) Thanks [@ijjk](https://github.com/ijjk)! - Collapse default workflow build output to a single completion summary and move detailed progress logs behind DEBUG=workflow:build.

- [#2445](https://github.com/vercel/workflow/pull/2445) [`67fcf1a`](https://github.com/vercel/workflow/commit/67fcf1a7505d131e6fbcaffc0d28551e4b17b8a7) Thanks [@pranaygp](https://github.com/pranaygp)! - Treat transient world-vercel transport failures as retryable, surfacing them as a `TRANSPORT` type `WorkflowWorldError`, to be retried by the queue instead of failing the run.

- Updated dependencies [[`ab24408`](https://github.com/vercel/workflow/commit/ab244082447eb60ad24faaad91ff4745af2481c5), [`f9119d4`](https://github.com/vercel/workflow/commit/f9119d4b6a39f93df8d97c338c62eb0b6bccad8d), [`db8a2c4`](https://github.com/vercel/workflow/commit/db8a2c49820530f7a331bb4c1f0a803e03547831), [`9fba14e`](https://github.com/vercel/workflow/commit/9fba14e409e1393e3abb01bd5ec4f3ebb5295c14), [`b06fa65`](https://github.com/vercel/workflow/commit/b06fa657f5e216fd3281534de96619a1d502ef4c), [`67fcf1a`](https://github.com/vercel/workflow/commit/67fcf1a7505d131e6fbcaffc0d28551e4b17b8a7), [`2a688f0`](https://github.com/vercel/workflow/commit/2a688f0a037e8d72bbc7164adc9f3be0924c62a3), [`2a688f0`](https://github.com/vercel/workflow/commit/2a688f0a037e8d72bbc7164adc9f3be0924c62a3), [`6dbe2de`](https://github.com/vercel/workflow/commit/6dbe2de33ff95fe16b627d77e9c690582a6857f2), [`af6ff4f`](https://github.com/vercel/workflow/commit/af6ff4f358a4dc008f0044ab2e53a14f79062b7e), [`87d213c`](https://github.com/vercel/workflow/commit/87d213c096ab88ec2c32c231440a65037f82bbf4)]:
  - @workflow/world-local@4.2.1
  - @workflow/world-vercel@4.5.0
  - @workflow/world@4.2.1
  - @workflow/errors@4.1.4

## 4.5.0

### Minor Changes

- [#2373](https://github.com/vercel/workflow/pull/2373) [`296b785`](https://github.com/vercel/workflow/commit/296b785db063add70db69645b07d158d6f1bf54f) Thanks [@pranaygp](https://github.com/pranaygp)! - Replace `hook.hasConflict` (a `Promise<boolean>` property) with `hook.getConflict()`, a method returning a promise that suspends the workflow to commit hook registration and resolves with `{ runId }` identifying the conflicting run when another active hook owns the token (or `null` once the hook is registered), without waiting for hook payload data. Code using `await hook.hasConflict` should migrate to `const conflict = await hook.getConflict()` and branch on `conflict !== null`.

- [#2305](https://github.com/vercel/workflow/pull/2305) [`9c667e0`](https://github.com/vercel/workflow/commit/9c667e05c2aad0158698099ac84a846e10ed5700) Thanks [@willsather](https://github.com/willsather)! - Add an optional `namespace` parameter that scopes queue topic prefixes to `__{namespace}_wkf_workflow_*`. This allows configuring multiple frameworks in the same deployment without queue topic collision.

### Patch Changes

- [#2345](https://github.com/vercel/workflow/pull/2345) [`2100fc3`](https://github.com/vercel/workflow/commit/2100fc3a362f6c6c1b2668663991ef9c2b6c182c) Thanks [@pranaygp](https://github.com/pranaygp)! - Fix unhandled rejection when `step_created`/`wait_created` calls fail in `waitUntil`

- [#2336](https://github.com/vercel/workflow/pull/2336) [`4291c59`](https://github.com/vercel/workflow/commit/4291c5950d5abe087b3f2ea288926553d08f7b8a) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Fix unexpected rejections in `waitUntil` causing process crashes

- [#1847](https://github.com/vercel/workflow/pull/1847) [`73975ad`](https://github.com/vercel/workflow/commit/73975ada17b10e5dc8f344f2aa356ad067ddc56e) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Auto-reconnect `getReadable()` streams on server close or transient errors

- Updated dependencies [[`253eeea`](https://github.com/vercel/workflow/commit/253eeeae0fbf8dc1d9aa551cc7b54260244d3a46), [`73975ad`](https://github.com/vercel/workflow/commit/73975ada17b10e5dc8f344f2aa356ad067ddc56e), [`9c667e0`](https://github.com/vercel/workflow/commit/9c667e05c2aad0158698099ac84a846e10ed5700), [`b5569a8`](https://github.com/vercel/workflow/commit/b5569a859052d0e3a7e43f2143cabef3e298c567)]:
  - @workflow/world-vercel@4.4.1
  - @workflow/world@4.2.0
  - @workflow/world-local@4.2.0
  - @workflow/errors@4.1.4

## 4.4.0

### Minor Changes

- [#1854](https://github.com/vercel/workflow/pull/1854) [`5077962`](https://github.com/vercel/workflow/commit/5077962d67c841fd7e81cf29ddedb017581dd501) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Surface `workflowCoreVersion` from the responding deployment in `healthCheck()` results.

### Patch Changes

- [#2012](https://github.com/vercel/workflow/pull/2012) [`326d93a`](https://github.com/vercel/workflow/commit/326d93a4aecb11a98a168e2409b5fae4d4c94167) Thanks [@pranaygp](https://github.com/pranaygp)! - Expose the active run ID on hook token conflict errors.

- [#2257](https://github.com/vercel/workflow/pull/2257) [`9acd46a`](https://github.com/vercel/workflow/commit/9acd46af13dd9aa55beb9ac6c4630fb7edce0c04) Thanks [@pranaygp](https://github.com/pranaygp)! - Avoid unhandled run lookups for unused or empty readable streams and include Vercel request correlation headers in world transport errors.

- [#2145](https://github.com/vercel/workflow/pull/2145) [`b385a2d`](https://github.com/vercel/workflow/commit/b385a2d6ebf35d665d32029777d0cf4018bc82dd) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Classify SDK-level AES-GCM encryption failures as `RUNTIME_ERROR` instead of `USER_ERROR` via a new `RuntimeDecryptionError`.

- [#2302](https://github.com/vercel/workflow/pull/2302) [`b93a071`](https://github.com/vercel/workflow/commit/b93a0717960dcdc9b8dc37f83cbebad8ec38f3b9) Thanks [@pranaygp](https://github.com/pranaygp)! - Update vulnerable package dependencies to patched releases.

- [#2292](https://github.com/vercel/workflow/pull/2292) [`2ab46de`](https://github.com/vercel/workflow/commit/2ab46de461685e7b93555d911c4b397e29f2e9cf) Thanks [@pranaygp](https://github.com/pranaygp)! - Bump `devalue` to 5.8.1 to address published security advisories.

- [#2214](https://github.com/vercel/workflow/pull/2214) [`e959124`](https://github.com/vercel/workflow/commit/e9591245bd8befe1a3859690a0027fd76822930f) Thanks [@pranaygp](https://github.com/pranaygp)! - Skip workflow replay when the event log already contains a terminal run event.

- [#1799](https://github.com/vercel/workflow/pull/1799) [`eca3b51`](https://github.com/vercel/workflow/commit/eca3b51a034b51e0c0ca89b949ee28d1f07a2cbb) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Use inline sourcemaps for all workspace packages; published packages no longer ship external `.js.map` files.

- Updated dependencies [[`a84a293`](https://github.com/vercel/workflow/commit/a84a293a229799c4b002fa769fa87b9b665ac9d9), [`326d93a`](https://github.com/vercel/workflow/commit/326d93a4aecb11a98a168e2409b5fae4d4c94167), [`95b3477`](https://github.com/vercel/workflow/commit/95b34775cd44e3de686e9a16a29618378cb0f32f), [`c74e5a3`](https://github.com/vercel/workflow/commit/c74e5a35e480ef58d9b6da21e370b9b0cd723639), [`9acd46a`](https://github.com/vercel/workflow/commit/9acd46af13dd9aa55beb9ac6c4630fb7edce0c04), [`b385a2d`](https://github.com/vercel/workflow/commit/b385a2d6ebf35d665d32029777d0cf4018bc82dd), [`c8c8ec1`](https://github.com/vercel/workflow/commit/c8c8ec1d55ac02284c0b1f3049d1c34b6190b11f), [`ecea733`](https://github.com/vercel/workflow/commit/ecea7339996e3c13283bfd29b1ee6d66bc791434), [`eca3b51`](https://github.com/vercel/workflow/commit/eca3b51a034b51e0c0ca89b949ee28d1f07a2cbb), [`8fde11c`](https://github.com/vercel/workflow/commit/8fde11c051b6951c63623c5be492974553736ae7)]:
  - @workflow/world-local@4.1.5
  - @workflow/errors@4.1.4
  - @workflow/world@4.1.5
  - @workflow/world-vercel@4.4.0
  - @workflow/serde@4.1.2
  - @workflow/utils@4.1.3

## 4.3.1

### Patch Changes

- Updated dependencies [[`5655fcb`](https://github.com/vercel/workflow/commit/5655fcbd4d5ed45c6669666fef8c817a286eec33)]:
  - @workflow/world-vercel@4.3.2

## 4.3.0

### Minor Changes

- [#2059](https://github.com/vercel/workflow/pull/2059) [`9092640`](https://github.com/vercel/workflow/commit/90926400131be4003e65d970deb5d67ae29778a2) Thanks [@TooTallNate](https://github.com/TooTallNate)! - A `WritableStream` from a workflow's `getWritable()` can now be passed as an argument to a child workflow via `start()`; the child's writes land on the parent run's stream directly for the full lifetime of the child run.

### Patch Changes

- [#2191](https://github.com/vercel/workflow/pull/2191) [`5a0ce9a`](https://github.com/vercel/workflow/commit/5a0ce9a700bb433ead4676d5d7f6bdb0bc6a6fdd) Thanks [@pranaygp](https://github.com/pranaygp)! - Fix forwarded writable stream encryption when child workflows execute on a newer deployment than their parent.

- [#2206](https://github.com/vercel/workflow/pull/2206) [`1e32d05`](https://github.com/vercel/workflow/commit/1e32d05758d590134f04f82ea41ab9add96104d5) Thanks [@pranaygp](https://github.com/pranaygp)! - Prevent replayed workflows from advancing their deterministic clock when a future event is inspected before its matching operation is invoked.

- [#2208](https://github.com/vercel/workflow/pull/2208) [`5fd7d9c`](https://github.com/vercel/workflow/commit/5fd7d9c2a1bca6e6ecaac7c0577e1ac58960711f) Thanks [@pranaygp](https://github.com/pranaygp)! - Retry transient workflow replay divergence before classifying repeated divergence as a corrupted event log.

- Updated dependencies [[`5a0ce9a`](https://github.com/vercel/workflow/commit/5a0ce9a700bb433ead4676d5d7f6bdb0bc6a6fdd), [`5fd7d9c`](https://github.com/vercel/workflow/commit/5fd7d9c2a1bca6e6ecaac7c0577e1ac58960711f)]:
  - @workflow/world@4.1.4
  - @workflow/errors@4.1.3
  - @workflow/world-local@4.1.4
  - @workflow/world-vercel@4.3.1

## 4.2.6

### Patch Changes

- [#2179](https://github.com/vercel/workflow/pull/2179) [`e256858`](https://github.com/vercel/workflow/commit/e25685889de027b13ef23f83e38633e41acc5e7d) Thanks [@pranaygp](https://github.com/pranaygp)! - Harden runtime event pagination against rejected, repeated, or overlapping cursor responses.

- [#2171](https://github.com/vercel/workflow/pull/2171) [`38c67a7`](https://github.com/vercel/workflow/commit/38c67a7f59d69a3743c981f29f31684a0e50f38d) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Fix `CorruptedEventLogError` on replay when a workflow races a hook read against a `sleep()` (e.g. `Promise.race([hook, sleep])`). Branch-deciding deliveries (buffered hook payloads and wait completions) are now handed to the workflow in strict event-log order — anchored on event position rather than on microtask-resolution timing — so the committed branch wins the race deterministically, independent of decryption/hydration time or `Promise.race` argument order.

- [#2156](https://github.com/vercel/workflow/pull/2156) [`ebfeede`](https://github.com/vercel/workflow/commit/ebfeede4bbf969c6fe6a27316d9ec60be9f726e5) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Harden workflow error stack remapping for large inline sourcemaps.

- [#2142](https://github.com/vercel/workflow/pull/2142) [`3113738`](https://github.com/vercel/workflow/commit/31137386eaed044aa6c75c04cd0bafc2e49edf1e) Thanks [@pranaygp](https://github.com/pranaygp)! - Prevent failed stream writes from surfacing as unhandled rejections and include request correlation details in stream errors.

- Updated dependencies [[`8ab6c4f`](https://github.com/vercel/workflow/commit/8ab6c4f0657a2aa26805a80b8db5798bdfe9847c), [`2aecfdb`](https://github.com/vercel/workflow/commit/2aecfdb7ff8f33cc8c630592a1f27d8d7630d5a8), [`3113738`](https://github.com/vercel/workflow/commit/31137386eaed044aa6c75c04cd0bafc2e49edf1e), [`17cf939`](https://github.com/vercel/workflow/commit/17cf939d48e163f1cc93942a9db1069793da1176)]:
  - @workflow/world@4.1.3
  - @workflow/world-local@4.1.3
  - @workflow/world-vercel@4.3.0
  - @workflow/errors@4.1.2

## 4.2.5

### Patch Changes

- [#2029](https://github.com/vercel/workflow/pull/2029) [`a434184`](https://github.com/vercel/workflow/commit/a4341848589f6b02f4dea048a58a05c72f0d816d) Thanks [@pranaygp](https://github.com/pranaygp)! - Refresh workflow events after completing elapsed waits so concurrent hook events preserve deterministic replay order.

- [#2046](https://github.com/vercel/workflow/pull/2046) [`8407c1e`](https://github.com/vercel/workflow/commit/8407c1e9a408bd60b1f3cd0367222d4f1d5d878d) Thanks [@pranaygp](https://github.com/pranaygp)! - Report corrupted event logs with a distinct `CorruptedEventLogError` type and `CORRUPTED_EVENT_LOG` run error code.

- [#2056](https://github.com/vercel/workflow/pull/2056) [`7487430`](https://github.com/vercel/workflow/commit/74874309cb416c239c53fe24742fb2739d010c2b) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Fix spurious "Event cursor missing after initial load" warning

- [#2030](https://github.com/vercel/workflow/pull/2030) [`c347509`](https://github.com/vercel/workflow/commit/c3475096e9811b2d20fc0b5bc65e0e24d1b58b49) Thanks [@pranaygp](https://github.com/pranaygp)! - Validate step, wait, and hook lifecycle events against replay ownership metadata.

- [#2060](https://github.com/vercel/workflow/pull/2060) [`ca5f355`](https://github.com/vercel/workflow/commit/ca5f355999320f3a37b7e2bb32ced09dab2a94a8) Thanks [@pranaygp](https://github.com/pranaygp)! - Record fatal world response contract failures as non-retryable workflow errors.

- [#1986](https://github.com/vercel/workflow/pull/1986) [`16f2c23`](https://github.com/vercel/workflow/commit/16f2c236d3b64643f07f5e85906c0112b7c132cc) Thanks [@pranaygp](https://github.com/pranaygp)! - Fix local workflow port detection, make generated health endpoints respond to HEAD requests, materialize manual webhook response bodies before returning them, wait for step return stream serialization before completing the step, bound Vercel stream and health-check operations so stuck writes or queue sends retry or time out instead of hanging, and stabilize remote Vercel e2e checks around CLI inspection, sleep timing, and hook registration/disposal.

- [#1935](https://github.com/vercel/workflow/pull/1935) [`6aabd6f`](https://github.com/vercel/workflow/commit/6aabd6fd2ef407c3a57835b2c51ceb881a77935f) Thanks [@TooTallNate](https://github.com/TooTallNate)! - Preserve the `this` binding of bound step proxies across workflow serialization, so passing `useStep(...).bind(thisArg)` as a step argument no longer loses the receiver.

- Updated dependencies [[`a434184`](https://github.com/vercel/workflow/commit/a4341848589f6b02f4dea048a58a05c72f0d816d), [`8407c1e`](https://github.com/vercel/workflow/commit/8407c1e9a408bd60b1f3cd0367222d4f1d5d878d), [`15e44b3`](https://github.com/vercel/workflow/commit/15e44b360535dcf1e5303cb7389db1f4007a24e8), [`c347509`](https://github.com/vercel/workflow/commit/c3475096e9811b2d20fc0b5bc65e0e24d1b58b49), [`a350e8d`](https://github.com/vercel/workflow/commit/a350e8ddf21b39b242a83c7e8c478d5ce5bd2001), [`ca5f355`](https://github.com/vercel/workflow/commit/ca5f355999320f3a37b7e2bb32ced09dab2a94a8), [`76352f0`](https://github.com/vercel/workflow/commit/76352f0b66514726fb4adde0a618fd1767436799), [`16f2c23`](https://github.com/vercel/workflow/commit/16f2c236d3b64643f07f5e85906c0112b7c132cc), [`e428cdb`](https://github.com/vercel/workflow/commit/e428cdb1d55b64956914a165ac57e0da76d1a33c), [`ecfccc3`](https://github.com/vercel/workflow/commit/ecfccc37c0ab19f2aff7fef9e6b6d62005b6c9c6), [`5f50bbc`](https://github.com/vercel/workflow/commit/5f50bbcee6b35ab275e49214c60143dab1f78c03), [`677867b`](https://github.com/vercel/workflow/commit/677867bd1919476625bd30da9fecde4405d19463)]:
  - @workflow/world@4.1.2
  - @workflow/world-local@4.1.2
  - @workflow/world-vercel@4.2.0
  - @workflow/errors@4.1.2
  - @workflow/utils@4.1.2

## 4.2.4

### Patch Changes

- Updated dependencies [[`7be05b9`](https://github.com/vercel/workflow/commit/7be05b9253ccde7f50ade103bc31ab12ec114d37)]:
  - @workflow/world-vercel@4.1.2

## 4.2.3

### Patch Changes

- [#1758](https://github.com/vercel/workflow/pull/1758) [`fb3c118`](https://github.com/vercel/workflow/commit/fb3c1188500a650c3681b253715b1cec707a6667) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - When runtime replays exceed 240s, re-try them up to three times, instead of failing immediately

- [#1726](https://github.com/vercel/workflow/pull/1726) [`6f48e9e`](https://github.com/vercel/workflow/commit/6f48e9e778d73d42ade3762ba3fff0e46877a812) Thanks [@workflow-devkit-release-bot](https://github.com/apps/workflow-devkit-release-bot)! - Embed source content in published sourcemaps.

- [`2ece7ba`](https://github.com/vercel/workflow/commit/2ece7ba25f4c76a01a3c900f7620af1c64d5fe85) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Fix community world E2E tests by adding `specVersion` to the World interface so `start()` uses the safe baseline (v2) for worlds that don't declare their supported version

- [#1726](https://github.com/vercel/workflow/pull/1726) [`7aab36b`](https://github.com/vercel/workflow/commit/7aab36b329055e5b3da4d9327e4546af06a7a9b4) Thanks [@workflow-devkit-release-bot](https://github.com/apps/workflow-devkit-release-bot)! - Fix false-positive unconsumed `step_created` errors when replay resumes a `for await` hook loop and appends more async work after the first promise-queue drain.

- Updated dependencies [[`5bc4191`](https://github.com/vercel/workflow/commit/5bc419179ef362150a4f1d5b83ef3b99361a548a), [`6f48e9e`](https://github.com/vercel/workflow/commit/6f48e9e778d73d42ade3762ba3fff0e46877a812), [`2ece7ba`](https://github.com/vercel/workflow/commit/2ece7ba25f4c76a01a3c900f7620af1c64d5fe85), [`3737caa`](https://github.com/vercel/workflow/commit/3737caab090a8047b393ad49bfb271553a36e17b)]:
  - @workflow/world-local@4.1.1
  - @workflow/errors@4.1.1
  - @workflow/serde@4.1.1
  - @workflow/utils@4.1.1
  - @workflow/world-vercel@4.1.1
  - @workflow/world@4.1.1

## 4.2.2

### Patch Changes

- [`f1cc68f`](https://github.com/vercel/workflow/commit/f1cc68f76a25241cd47058e5c2f5855d051dea71) Thanks [@karthikscale3](https://github.com/karthikscale3)! - Make encrypted markers clickable to trigger decryption and detect encryption at run level before span selection. Persist `features.encryption` flag in `executionContext` at run creation so the UI can detect encryption without a probe fetch.

## 4.2.1

### Patch Changes

- [#1657](https://github.com/vercel/workflow/pull/1657) [`f5fb9b7`](https://github.com/vercel/workflow/commit/f5fb9b7a8f6dbfe74a2651381558248fd067db46) Thanks [@workflow-devkit-release-bot](https://github.com/apps/workflow-devkit-release-bot)! - Remove redundant `hc_` prefix from health check correlationId that caused doubled `hc_hc_` in the derived runId and stream name.

## 4.2.0

### Patch Changes

- [#1640](https://github.com/vercel/workflow/pull/1640) [`8890b33`](https://github.com/vercel/workflow/commit/8890b33b9b6497824309ced298a7b1acab73142c) Thanks [@VaguelySerious](https://github.com/VaguelySerious)! - Stable release

- Updated dependencies [[`8890b33`](https://github.com/vercel/workflow/commit/8890b33b9b6497824309ced298a7b1acab73142c)]:
  - @workflow/errors@4.1.0
  - @workflow/serde@4.1.0
  - @workflow/utils@4.1.0
  - @workflow/world@4.1.0
  - @workflow/world-local@4.1.0
  - @workflow/world-vercel@4.1.0

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
