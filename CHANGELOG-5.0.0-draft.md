# Workflow SDK 5.0.0 — Aggregate Changelog

Everything released across `workflow@5.0.0-beta.0` → `beta.36` (2026-04-08 → 2026-07-22), plus changes merged to `main` but not yet released, **excluding anything also shipped in a `4.x` release** (4.2.0 → 4.6.2).

Matching is by PR number across all release bodies — the same PR number appears in both lines when a change was cherry-picked, even though the commit SHA (and sometimes the wording) differs.

| | Count |
|---|---|
| PRs in the 5.x line (beta.0 → beta.36) | 348 |
| Also shipped in 4.x (backported — excluded) | 108 |
| **Exclusive to 5.x, released** | **240** |
| **Exclusive to 5.x, merged but unreleased** | **12** |
| **Total in this document** | **252** |

Organized by change severity, then thematically — not by subpackage.

---

## 🔴 Breaking Changes

- **`getWorld()` / `createWorld()` are now async**, to support ESM dynamic imports for custom world modules. All callers must `await getWorld()`. ([#942](https://github.com/vercel/workflow/pull/942))
- **World stream methods moved into a `world.streams.*` namespace**, with `runId` promoted to the first parameter: `writeToStream(name, runId, chunk)` → `streams.write(runId, name, chunk)`, `writeToStreamMulti` → `streams.writeMulti`, `closeStream` → `streams.close`, `readFromStream` → `streams.get(runId, name, startIndex?)`, `listStreamsByRunId` → `streams.list(runId)`. `world.steps.get` now requires `runId`. ([#1293](https://github.com/vercel/workflow/pull/1293))
- **Removed the `@workflow/core/private` and `workflow/internal/private` subpath exports.** Step registrations are now inlined as self-contained IIFEs (with closure variables inlined) immediately after each function definition, instead of a batched import. This also lets third-party packages define step functions without depending on `workflow` in `node_modules`. ([#1632](https://github.com/vercel/workflow/pull/1632))
- **Removed path-based `isWorkflowSdkFile` serde exclusion** — serde discovery is now AST-level (SWC detect mode) across all integration paths. ([#1662](https://github.com/vercel/workflow/pull/1662))
- **Removed the `client` SWC transform mode**, merged into `step` mode, which now absorbs hoisted variable references and DCE. Integrations passing `mode: 'client'` must move to `mode: 'step'`. ([#1686](https://github.com/vercel/workflow/pull/1686))
- **Run and step errors now serialize through the full workflow serialization pipeline**, preserving class identity and cause chains on `WorkflowRunFailedError.cause`. Failed runs created before the upgrade, stored in `world-postgres`'s legacy `error` text column, read back as `error: undefined` (the payload is still recoverable from `errorJson`). ([#1851](https://github.com/vercel/workflow/pull/1851))
- **The suspension/dispatch contract for World implementers changed.** The old asymmetric `{ timeoutSeconds }` return contract for waits is gone — waits are ordinary queue continuations with `delaySeconds`, and wait + step dispatch is unified into one parallel batch per suspension. Custom World packages relying on the old wait-return contract need updating. ([#1925](https://github.com/vercel/workflow/pull/1925))
- **Duplicate step/workflow IDs across non-exported workspace files now fail the build** instead of silently colliding last-write-wins. ([#2018](https://github.com/vercel/workflow/pull/2018))
- **Deterministic RNG/clock seed derivation changed** to `runId:workflowName:deploymentId` (dropping `startedAt`), with the initial clock seeded from the runId's ULID timestamp. This changes the seed-derived value sequence — step/hook correlation IDs, nanoids, random values — for a given run. **Runs started before this change must not be replayed across the upgrade.** ([#2525](https://github.com/vercel/workflow/pull/2525))
- **Worlds are statically injected into host bundles at build time** instead of being selected dynamically at runtime, and first-party World packages standardized on a `createWorld()` factory. Custom and community world consumers should verify resolution still works — several follow-ups were needed ([#2799](https://github.com/vercel/workflow/pull/2799), [#2802](https://github.com/vercel/workflow/pull/2802), [#2804](https://github.com/vercel/workflow/pull/2804), [#2806](https://github.com/vercel/workflow/pull/2806)). ([#2752](https://github.com/vercel/workflow/pull/2752), [#2468](https://github.com/vercel/workflow/pull/2468))
- **`NestLocalBuilder` moved out of the `@workflow/nest` package root** to the `@workflow/nest/builder` subpath, so importing `WorkflowModule` no longer pulls the build toolchain into the runtime bundle. Shipped alongside the new `workflow-nest build --vercel` command and `NestVercelBuilder` at `@workflow/nest/vercel-builder`. ([#2988](https://github.com/vercel/workflow/pull/2988))
- **`experimental_setAttributes` renamed to `setAttributes`** now that attributes are no longer experimental. The old name remains as a deprecated alias. ([#2882](https://github.com/vercel/workflow/pull/2882))

### Default-behavior changes worth auditing

- **The event-creation optimistic-concurrency guard is now on by default** (`WORKFLOW_PRECONDITION_GUARD=0` to opt out). ([#2946](https://github.com/vercel/workflow/pull/2946))
- **Turbo mode is on by default** (`WORKFLOW_TURBO=0` to disable). ([#2526](https://github.com/vercel/workflow/pull/2526))
- **`WORKFLOW_TRACE_MODE=linked` is the new default** — each invocation is its own trace root with span links rather than one deep trace. ([#2363](https://github.com/vercel/workflow/pull/2363), [#2527](https://github.com/vercel/workflow/pull/2527))
- **`lazyDiscovery: true` is the default** for `withWorkflow` on Next.js ≥ 16.2.0-canary.48; older versions fall back to eager discovery automatically. ([#1805](https://github.com/vercel/workflow/pull/1805))
- **Build output moved from CJS to ESM** for step/workflow/webhook bundles (with a `createRequire` banner for CJS deps). The VM-executed workflow bundle stays CJS. ([#1562](https://github.com/vercel/workflow/pull/1562))
- **A server-supplied per-run event limit is now enforced** (default 25K). ([#2986](https://github.com/vercel/workflow/pull/2986))
- **Stream writes now dispatch the first chunk of an idle stream immediately** (flush window default 0 instead of 10ms); opt back into a windowed leading edge via `streamFlushIntervalMs` / `WORKFLOW_STREAM_FLUSH_INTERVAL_MS`. *(unreleased)* ([#3088](https://github.com/vercel/workflow/pull/3088))

---

## 🟢 New Features & Enhancements

### Runtime & execution model

- Turbo mode: first delivery backgrounds `run_started`, skips the initial event-log load, and forces optimistic inline start, so first steps execute with no preceding round-trips. ([#2526](https://github.com/vercel/workflow/pull/2526), perf follow-up [#2569](https://github.com/vercel/workflow/pull/2569))
- Parallel inline step execution up to `WORKFLOW_MAX_INLINE_STEPS` (default 3), each lazily created; opt-in `WORKFLOW_OPTIMISTIC_INLINE_START` begins step bodies before `step_started` is confirmed. ([#2516](https://github.com/vercel/workflow/pull/2516))
- Lazy inline step start — a single `step_started` call now carries the step input, saving a round-trip per inline step. ([#2478](https://github.com/vercel/workflow/pull/2478))
- Skip the per-step incremental `events.list` round-trip in the inline sequential loop by consuming the event-log delta from the step's terminal write. ([#2475](https://github.com/vercel/workflow/pull/2475))
- Inline steps excluded from the replay timeout, with a `WORKFLOW_REPLAY_TIMEOUT_MS` override and a `World.processExitTriggersQueueRedelivery` capability flag. ([#2013](https://github.com/vercel/workflow/pull/2013))
- Replays exceeding 240s are retried up to 3× instead of failing immediately. ([#1740](https://github.com/vercel/workflow/pull/1740))
- Skip replay entirely when a refreshed event log already contains a terminal run event. ([#2215](https://github.com/vercel/workflow/pull/2215))
- Encrypted replay payloads are prepared concurrently, and the decrypted/decompressed representation is cached for reuse across inline replay iterations. ([#2980](https://github.com/vercel/workflow/pull/2980))
- Runtime tuning constants (timeouts, retry counts, stream buffering/reconnect) are configurable via `WORKFLOW_*` env vars; a `WORKFLOW_TEST_LIMIT_OVERRIDES` header lets a deployment tighten server-side limits for testing. ([#2718](https://github.com/vercel/workflow/pull/2718))
- `start()` can be called directly inside workflow functions. ([#1491](https://github.com/vercel/workflow/pull/1491))
- `WORKFLOW_SEQUENTIAL_REPLAYS` (opt-in, also enabled by the `WORKFLOW_SAFE_MODE=1` umbrella flag): flow/orchestrator routes are limited to one invocation per run via a per-run queue topic and `maxConcurrency: 1`. Step routes are unaffected. ([#2193](https://github.com/vercel/workflow/pull/2193))
- Optimistic-concurrency guard for event creation: replay-context event creations send a `stateUpdatedAt` snapshot, and the runtime reloads the event log and retries — then falls back to a queue re-invocation — when the backend reports a newer out-of-band event with a 412 `PreconditionFailedError`. ([#2266](https://github.com/vercel/workflow/pull/2266))
- `capabilities?: WorldCapabilities` on the World interface lets implementations declare backend feature support (`preconditionGuard`, `maxConcurrency`) instead of the runtime inferring it from env vars. The inline event-log delta fast path stays active with open hooks when the guard is on and declared; the lazy inline `step_started` claim carries the guard snapshot so a stale replay's claim is fenced. ([#2970](https://github.com/vercel/workflow/pull/2970))
- Compression pipeline: step/workflow payloads, errors, and hook payloads are compressed before encryption (zstd preferred via `node:zlib`, gzip portable fallback), gated on run `specVersion` 5, with `WORKFLOW_DISABLE_COMPRESSION` / `WORKFLOW_COMPRESSION_CODEC` overrides and OTEL attributes for compression ratio and sizes. ([#2394](https://github.com/vercel/workflow/pull/2394), cutoff fix [#2470](https://github.com/vercel/workflow/pull/2470))
- `specVersion` added to the World interface so `start()` uses the safe baseline (v2) for worlds that don't declare a supported version. ([#1658](https://github.com/vercel/workflow/pull/1658))
- `World.createRunId(options?)` and `region` on `QueueOptions`: worlds can mint custom run IDs and route messages to a specific region. World-vercel mints region-tagged ULIDs preferring `options.region`, then `VERCEL_REGION`, then `iad1`, and the queue routes each message to the region encoded in the tagged run ID. ([#1981](https://github.com/vercel/workflow/pull/1981))
- Cross-run lineage: runs started from inside a workflow or step are tagged with `$parentRunId` and inherit the parent's `$rootRunId`, so fan-outs and daisy chains of any depth group under one root. ([#2153](https://github.com/vercel/workflow/pull/2153))
- `runs.getMany()` retrieves ordered run snapshots in one storage operation. ([#2915](https://github.com/vercel/workflow/pull/2915))
- `experimental_minRetention` keeps a Hook token unavailable after its run ends; supporting Worlds must advertise the `hookRetention` capability. ([#2865](https://github.com/vercel/workflow/pull/2865))
- `maxRetries` is enforced for inline and backgrounded steps that time out. ([#3035](https://github.com/vercel/workflow/pull/3035))
- Auto-reconnecting object streams when the server connection times out ([#2318](https://github.com/vercel/workflow/pull/2318)), plus a v3 stream-read endpoint on world-vercel supporting transparent reconnects ([#2424](https://github.com/vercel/workflow/pull/2424)).
- `features.encryption` exposed on `getWorkflowMetadata()`. ([#1652](https://github.com/vercel/workflow/pull/1652))

### Run attributes & metadata

- `experimental_setAttributes()` ([#2134](https://github.com/vercel/workflow/pull/2134)), callable from steps ([#2157](https://github.com/vercel/workflow/pull/2157)), initial attributes via `start()` with native-event recording ([#2226](https://github.com/vercel/workflow/pull/2226)), and `allowReservedAttributes` for framework-level `$`-prefixed keys ([#2385](https://github.com/vercel/workflow/pull/2385)).
- Optional `cancelReason` on `run.cancel()`. ([#2840](https://github.com/vercel/workflow/pull/2840))
- `replayedFromRunId` stamped by `recreateRunFromExisting` / `start`. ([#2872](https://github.com/vercel/workflow/pull/2872))
- `namespace` option for `start()`, `recreateRunFromExisting()`, `reenqueueRun()` and `wakeUpRun()`, plus a `healthCheck()` timeout fix. ([#2874](https://github.com/vercel/workflow/pull/2874))

### Errors & serialization

- Friendlier runtime errors: new `SerializationError`, `WorkflowBuildError`, and structured context-violation classes (e.g. `NotInWorkflowContextError`) with docs links; `errorAttribution` (`user` vs `sdk`); namespaced `[workflow-sdk]` logs with a color-coded formatter. ([#1849](https://github.com/vercel/workflow/pull/1849))
- `AbortController` / `AbortSignal` are serializable across workflow and step boundaries; pending queue items are drained rather than only warned about, and unaborted system hooks are disposed at workflow completion. ([#1301](https://github.com/vercel/workflow/pull/1301))
- Built-in Error subclasses (`TypeError`, `RangeError`, `SyntaxError`, …) serialize with `cause` preserved ([#1511](https://github.com/vercel/workflow/pull/1511)); `FatalError` / `RetryableError` round-trip with class identity, including from non-SWC environments ([#1513](https://github.com/vercel/workflow/pull/1513)); `Run` instances get custom serialization with e2e boundary coverage ([#1616](https://github.com/vercel/workflow/pull/1616)); workflow function references are serializable ([#1677](https://github.com/vercel/workflow/pull/1677)).

### Observability, tracing & analytics

- `WORKFLOW_TRACE_MODE=linked`: each invocation is its own trace root with span links, plus W3C `traceparent` / `tracestate` / `baggage` injection. ([#2363](https://github.com/vercel/workflow/pull/2363), refined [#2527](https://github.com/vercel/workflow/pull/2527))
- OTEL spans and turbo tagging around `/flow` init. ([#2592](https://github.com/vercel/workflow/pull/2592))
- Time-to-first-step and step-to-step overhead latency telemetry ([#2833](https://github.com/vercel/workflow/pull/2833)); step progress reporting ([#2850](https://github.com/vercel/workflow/pull/2850)); stream latency spans ([#2857](https://github.com/vercel/workflow/pull/2857)).
- Run-started-to-first-step (`rsfs`) and final-scheduling-replay latency reported on step completion events. ([#2929](https://github.com/vercel/workflow/pull/2929)), with a follow-up fixing TTFS telemetry reporting 0 for runs with region-tagged run IDs ([#2943](https://github.com/vercel/workflow/pull/2943))
- Client-observed stream telemetry: a `workflow.stream.flush` span per write batch with `buffer_dwell_ms` separating client batching cost from network time ([#2891](https://github.com/vercel/workflow/pull/2891)), later moved into core with `chunk_rtt`, `connect_ms`, and new `workflow.stream.close` / `workflow.stream.read.complete` spans, deduping `@opentelemetry/api` to one workspace instance ([#2901](https://github.com/vercel/workflow/pull/2901)).
- `world.analytics`: an optional metadata-only namespace for observability reads (runs/steps/events/hooks/waits), implemented by world-vercel ([#2234](https://github.com/vercel/workflow/pull/2234)), consumed by the web run/step/event list views ([#2647](https://github.com/vercel/workflow/pull/2647)), CLI `inspect` list views with `--withData` deprecated for lists ([#2648](https://github.com/vercel/workflow/pull/2648)), and the hooks list, where secret tokens are no longer included in list rows ([#2652](https://github.com/vercel/workflow/pull/2652)).
- `analytics.attributes.list()` for attribute key discovery, plus an `attributes` key=value filter on `analytics.runs.list()`. ([#2903](https://github.com/vercel/workflow/pull/2903))
- `World.describeRun` hook surfaces world-specific run fields (e.g. region on Vercel) in `workflow inspect`. ([#2896](https://github.com/vercel/workflow/pull/2896))
- CLI `inspect runs --since/--until`; `start` and bulk `cancel` name lookups search past the default 24h window; `world.analytics.runs.list` gained `startTime`/`endTime`; the runs list UI gained infinite scroll with SWR caching and a time-window/status picker. ([#2812](https://github.com/vercel/workflow/pull/2812))

### Trace viewer (`@workflow/web`, `@workflow/web-shared`)

A ground-up replacement of the observability trace UI, delivered incrementally:

- Clickable Run references ([#1681](https://github.com/vercel/workflow/pull/1681)); encrypted-marker and inline decryption support ([#1716](https://github.com/vercel/workflow/pull/1716), [#1722](https://github.com/vercel/workflow/pull/1722)); UTF-8 stream chunk decoding ([#1852](https://github.com/vercel/workflow/pull/1852)).
- Detail pane, middle-truncate and timeline polish ([#1883](https://github.com/vercel/workflow/pull/1883)); virtualization for large runs ([#2205](https://github.com/vercel/workflow/pull/2205)).
- `attr_set` event rendering with a dedicated Attributes card ([#2393](https://github.com/vercel/workflow/pull/2393), [#2327](https://github.com/vercel/workflow/pull/2327)).
- Reworked JSON data inspector with bracket notation, disclosure icons and `serializeForClipboard` ([#2434](https://github.com/vercel/workflow/pull/2434)); point-in-time event markers ([#2452](https://github.com/vercel/workflow/pull/2452)); resizable, user-draggable detail panel ([#2773](https://github.com/vercel/workflow/pull/2773)); minimap with pan/zoom/brush ([#2800](https://github.com/vercel/workflow/pull/2800)).
- Keyboard navigation: J/K auto-scroll ([#2366](https://github.com/vercel/workflow/pull/2366)), arrow keys ([#2694](https://github.com/vercel/workflow/pull/2694)), shortcut tooltips ([#2163](https://github.com/vercel/workflow/pull/2163)) and helper text ([#2582](https://github.com/vercel/workflow/pull/2582)).
- Alt-held span-to-span time measurement, Figma-style, with the no-selection gap overlay restyled to match. ([#2985](https://github.com/vercel/workflow/pull/2985))
- Split-pane divider drag matched to the detail panel: wider hit target, hover/focus/drag highlight, double-click reset, keyboard/ARIA resize. ([#2838](https://github.com/vercel/workflow/pull/2838))
- Loading skeleton exported as `TraceViewerSkeleton` ([#2164](https://github.com/vercel/workflow/pull/2164)); precise sub-second durations ([#2335](https://github.com/vercel/workflow/pull/2335)); `getModuleSourceUrl` resolver for linking to source ([#2817](https://github.com/vercel/workflow/pull/2817)); HookConflictError hydration ([#2249](https://github.com/vercel/workflow/pull/2249)); search matching/highlighting and a reusable icon button ([#2144](https://github.com/vercel/workflow/pull/2144)).
- gzip/zstd decompression for OSS web hydration via a WASM-backed zstd decoder. ([#2680](https://github.com/vercel/workflow/pull/2680))
- Metadata Token and Hook ID rows gained copy buttons with middle truncation ([#2947](https://github.com/vercel/workflow/pull/2947)); Input/Output sections stay open after decrypting run data ([#2826](https://github.com/vercel/workflow/pull/2826)); detail-panel top info rows grouped into a collapsible monospace Metadata section ([#2604](https://github.com/vercel/workflow/pull/2604)); delayed hover tooltips on event-list row icons ([#2962](https://github.com/vercel/workflow/pull/2962)).
- Queued span time renders as a lead-in connector into the active bar instead of a filled gray box ([#2381](https://github.com/vercel/workflow/pull/2381)); in-progress segments animate ([#2383](https://github.com/vercel/workflow/pull/2383)); hook bars recolored gray instead of amber ([#2950](https://github.com/vercel/workflow/pull/2950)).
- Additional visual polish: [#1973](https://github.com/vercel/workflow/pull/1973), [#2006](https://github.com/vercel/workflow/pull/2006), [#2022](https://github.com/vercel/workflow/pull/2022), [#2036](https://github.com/vercel/workflow/pull/2036), [#2041](https://github.com/vercel/workflow/pull/2041), [#2045](https://github.com/vercel/workflow/pull/2045), [#2209](https://github.com/vercel/workflow/pull/2209), [#2459](https://github.com/vercel/workflow/pull/2459), [#2483](https://github.com/vercel/workflow/pull/2483), [#2520](https://github.com/vercel/workflow/pull/2520), [#2595](https://github.com/vercel/workflow/pull/2595), [#2614](https://github.com/vercel/workflow/pull/2614), [#2695](https://github.com/vercel/workflow/pull/2695), [#2832](https://github.com/vercel/workflow/pull/2832), [#2835](https://github.com/vercel/workflow/pull/2835), [#2837](https://github.com/vercel/workflow/pull/2837), [#2864](https://github.com/vercel/workflow/pull/2864), [#2968](https://github.com/vercel/workflow/pull/2968).

### Build & framework integrations

- A combined flow+step route handler executes steps inline where possible, cutting function invocations and queue overhead; default concurrency raised to 50. ([#1338](https://github.com/vercel/workflow/pull/1338))
- Synchronous functions and getters can use `"use step"` ([#1633](https://github.com/vercel/workflow/pull/1633), [#1630](https://github.com/vercel/workflow/pull/1630)); SWC gained a `detect` mode used during discovery to filter false-positive directive detections ([#1641](https://github.com/vercel/workflow/pull/1641)).
- New `sourcemap` builder option mirroring esbuild's values, plus a `WORKFLOW_SOURCEMAP` env var ([#1842](https://github.com/vercel/workflow/pull/1842)); sourcemaps default to `'inline'` in dev and off in production, with faster stack-trace remapping when absent ([#2529](https://github.com/vercel/workflow/pull/2529)); source content embedded in published sourcemaps ([#1769](https://github.com/vercel/workflow/pull/1769)).
- Vercel Deployment Protection bypass switched to OIDC Trusted Sources via `getVercelOidcToken()`, superseding the `VERCEL_WORKFLOW_SERVER_PROTECTION_BYPASS` env var added a few betas earlier. ([#1882](https://github.com/vercel/workflow/pull/1882), env var introduced in [#1824](https://github.com/vercel/workflow/pull/1824))
- Deferred Next.js builds stop eager input-graph directive discovery and rely on loader/socket-driven discovery with `onBeforeDeferredEntries`. ([#1646](https://github.com/vercel/workflow/pull/1646))
- Next.js workflow diagnostics manifests are written inside the Next.js dist directory; `.vercel/output/diagnostics` is reserved for the Build Output API builder. ([#1857](https://github.com/vercel/workflow/pull/1857))
- `workflow-nest build --vercel` emits a Vercel Build Output API directory, enabling NestJS deployment on Vercel. ([#2988](https://github.com/vercel/workflow/pull/2988))
- Filesystem polling in `world-local` for cross-process streaming in local dev. ([#1739](https://github.com/vercel/workflow/pull/1739))
- Standalone `workflow web` deploy-to-Vercel support, using `vercelPreset()` from `@vercel/react-router/vite` for per-route splitting. ([#1732](https://github.com/vercel/workflow/pull/1732), [#1815](https://github.com/vercel/workflow/pull/1815))
- A default request timeout on world-vercel HTTP calls, so hanging responses retry sooner instead of running until function timeout. ([#1807](https://github.com/vercel/workflow/pull/1807))
- `@workflow/ai`: forwards `strict` / `inputExamples` / `providerOptions` tool properties and handles `type: 'dynamic'` tools ([#1544](https://github.com/vercel/workflow/pull/1544)); preserves malformed streamed tool-call input for repair hooks ([#1707](https://github.com/vercel/workflow/pull/1707)); `DurableAgent.stream()` exposes `totalUsage` and `finishReason` ([#1863](https://github.com/vercel/workflow/pull/1863)).

### Performance

- Skip transferring event payload bytes when listing events with `resolveData: 'none'` on the v4 API. ([#2415](https://github.com/vercel/workflow/pull/2415))
- Honor the server's explicit pagination flag when listing run events, avoiding one extra empty-page request per event-log load on replay. ([#2486](https://github.com/vercel/workflow/pull/2486))
- Reduce local sequential-step replay I/O with bounded recent-event and storage-directory caches. ([#2152](https://github.com/vercel/workflow/pull/2152))
- Shard local stream chunks into a directory per stream, so a tail reader's poll no longer lists every chunk in the world on each tick, and reliably release emitter listeners and the poll timer on cancellation. Steps receiving an `AbortSignal` no longer pay a per-step queue round-trip: the real-time abort-stream reader is released when the step finishes, letting it complete inline. **Note:** chunks now live at `streams/chunks/<streamName>/`; files written in the old flat layout are not read back, and stale flat files are left in place. ([#2807](https://github.com/vercel/workflow/pull/2807))
- Hook operations in `world-local` no longer scale with total event history: hook creation, cache rebuilds and token lookups use durable per-token/per-hookId indexes instead of scanning the global event log; run-termination cleanup uses per-run markers; directory listings read concurrently; `runs.list` defaults to a page size of 200. ([#2830](https://github.com/vercel/workflow/pull/2830))
- Avoid a separate esbuild steps bundle in Next.js lazy discovery mode. ([#2263](https://github.com/vercel/workflow/pull/2263))
- Avoid resolving run data before background step execution. ([#2993](https://github.com/vercel/workflow/pull/2993))

---

## 🟡 Fixes

### Runtime & core

- `Promise.race(step, sleep)` no longer always blocks until the step completes. ([#1924](https://github.com/vercel/workflow/pull/1924))
- Fixed a race where an `AbortController` aborted from a step wasn't reflected in a subsequent step's `signal`. ([#2412](https://github.com/vercel/workflow/pull/2412))
- Fixed duplicate inline step execution when a hook or wait wakes a run while the step is still running: the lazy `step_started` now records the owning queue message ID with a delayed backstop (`WORKFLOW_INLINE_OWNERSHIP=0` to disable). ([#2848](https://github.com/vercel/workflow/pull/2848))
- Fixed a turbo-mode race where a fire-and-forget hook, wait or attribute write could reach the server before the run was created. ([#2685](https://github.com/vercel/workflow/pull/2685))
- Retry inline step completion persistence failures instead of recording them as step failures. ([#2666](https://github.com/vercel/workflow/pull/2666))
- Fixed a `CorruptedEventLogError` false positive for `Promise.race([hook, sleep])` — branch-deciding deliveries are ordered by event position, not microtask timing. ([#2185](https://github.com/vercel/workflow/pull/2185))
- Prevented replayed workflows from advancing their deterministic clock before the matching operation is invoked. ([#2211](https://github.com/vercel/workflow/pull/2211))
- Retry transient replay divergence before classifying it as a corrupted event log. ([#2212](https://github.com/vercel/workflow/pull/2212))
- Hardened event-log pagination against rejected, repeated and overlapping cursor responses. ([#2180](https://github.com/vercel/workflow/pull/2180))
- Fixed false-positive unconsumed `step_created` errors when replay resumes a `for await` hook loop. ([#1778](https://github.com/vercel/workflow/pull/1778))
- `getWritable()` no longer returns a new `TransformStream` per call, which reordered racing pipes; it now shares one pipe per `(runId, namespace)`. ([#2086](https://github.com/vercel/workflow/pull/2086))
- Replaced `eval` with `JSON.parse` in the `revive()` deserialization helper. ([#1848](https://github.com/vercel/workflow/pull/1848))
- Replaced the `chalk` import in `@workflow/errors/ansi` with an inline ANSI shim — `chalk` → `supports-color` called `require('os')` at load time, crashing every workflow in the sandboxed VM. ([#1915](https://github.com/vercel/workflow/pull/1915))
- Fixed missing serialization revivers for `FatalError` / `RetryableError` / built-in Error subclasses / `AggregateError` / `DOMException` in the web UI. ([#1942](https://github.com/vercel/workflow/pull/1942))
- Fixed `world.ts` being tree-shaken out of the bundle. ([#1951](https://github.com/vercel/workflow/pull/1951))
- Fixed Zod 4.4.x compatibility in `WorkflowRunSchema`. ([#1939](https://github.com/vercel/workflow/pull/1939))
- `AbortError` step failures, including cross-realm and serialized ones, are treated as fatal cancellations. ([#2150](https://github.com/vercel/workflow/pull/2150))
- Reject an explicit empty-string `token` in `createHook()`. ([#2490](https://github.com/vercel/workflow/pull/2490))
- Refresh workflow events after completing elapsed waits so concurrent hook events preserve deterministic replay order. ([#2038](https://github.com/vercel/workflow/pull/2038))
- Removed the redundant `hc_` prefix from health-check `correlationId`, which produced a doubled `hc_hc_` in the derived runId and stream name. ([#1678](https://github.com/vercel/workflow/pull/1678))
- Fixed the false "data expired" CLI warning for runs with a future `expiredAt`. ([#1736](https://github.com/vercel/workflow/pull/1736))

### Streams

- Fixed stream writes never batching: `flushablePipe` awaited each `writer.write()` and the sink serialized chunks one at a time, so the server writable's buffer never held more than one chunk and its `writeMulti` path never engaged — every chunk became its own round trip. Coalesced batches split at `WORKFLOW_STREAM_MAX_CHUNKS_PER_BATCH` and `WORKFLOW_STREAM_MAX_BYTES_PER_BATCH`, independent of the `WORKFLOW_STREAM_MAX_INFLIGHT_CHUNKS` backpressure bound. ([#2995](https://github.com/vercel/workflow/pull/2995))
- Use a custom stream close control frame to decide whether to reconnect. ([#1742](https://github.com/vercel/workflow/pull/1742))
- Retry stream close on retriable 5xx — close is idempotent on the server, unlike chunk appends, and the server may return 503s expecting the writer to close again. ([#3038](https://github.com/vercel/workflow/pull/3038))
- Stream write batching moved into the server writable itself (group commit), so raw `ReadableStream`s piped across workflow/step boundaries batch the same as `getWritable()` instead of sending one request per chunk. *(unreleased)* ([#3078](https://github.com/vercel/workflow/pull/3078))

### Worlds — local & postgres

- Fixed a race where concurrent `step_created` / `hook_created` / `wait_created` writes with the same `correlationId` both succeeded instead of one losing with `EntityConflictError`; a unique partial index was added on postgres. ([#1877](https://github.com/vercel/workflow/pull/1877), [#1878](https://github.com/vercel/workflow/pull/1878))
- `run_failed` against a nonexistent run throws `WorkflowRunNotFoundError`, matching postgres and vercel. ([#1894](https://github.com/vercel/workflow/pull/1894))
- `world-postgres` throws `EntityConflictError` when a `run_created` event targets an existing run instead of resolving with no run, matching the other worlds and stopping `start()` from throwing `Missing 'run' in server response for 'run_created' event` when the resilient start path wins the race. ([#2983](https://github.com/vercel/workflow/pull/2983))
- Reject `hook_received` on terminal runs, including when the termination commits concurrently cross-process, and for legacy pre-event-sourcing runs. ([#2987](https://github.com/vercel/workflow/pull/2987))
- Fixed local-world recovery isolation in Vitest and support for custom test directories. ([#1895](https://github.com/vercel/workflow/pull/1895))
- Retry local queue deliveries that fail at the transport (`fetch failed` / `ETIMEDOUT`) instead of dropping the message. ([#2679](https://github.com/vercel/workflow/pull/2679))
- Rejected dots and empty `correlationId` values in entity ID validation. ([#2097](https://github.com/vercel/workflow/pull/2097))
- Fixed a stalled hook token claim release deleting the next claimant's live claim, and a `resumeHook` / `dispose()` race that corrupted the receiving run's replay. ([#2808](https://github.com/vercel/workflow/pull/2808))
- Fixed `createHook()` conflicting with the run's own disposed hook on token reuse, and claims not reaching the next claimant. ([#2779](https://github.com/vercel/workflow/pull/2779))
- Use the active queue namespace when re-enqueuing runs during world startup recovery. ([#2888](https://github.com/vercel/workflow/pull/2888))
- `WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS` env var as a fallback for the `recoverActiveRuns` option, so startup re-enqueueing can be disabled without a custom world module. ([#2914](https://github.com/vercel/workflow/pull/2914))
- On shutdown, abort stalled workflow and step HTTP deliveries after Graphile Worker's grace period so Postgres job rows unlock through normal failure handling instead of waiting for stale-lock recovery; aborted deliveries consume an attempt and retry only when budget remains. Adds opt-in application-managed shutdown via `applicationManagedShutdown` / `WORKFLOW_POSTGRES_APPLICATION_MANAGED_SHUTDOWN=1`. *(unreleased)* ([#3064](https://github.com/vercel/workflow/pull/3064))

### World — Vercel

- `streams.get()` includes `runId` in the request URL. ([#1676](https://github.com/vercel/workflow/pull/1676))
- Injected W3C trace context on v4 event requests, restoring backend span correlation for flow-route traffic. ([#2533](https://github.com/vercel/workflow/pull/2533))
- Routed v4 event requests through global `fetch` so they appear in the Vercel observability outgoing-requests view. ([#2514](https://github.com/vercel/workflow/pull/2514))
- Cancel the v4 event frame stream when a reader stops early, returning the undici connection to the pool instead of leaking it. ([#2873](https://github.com/vercel/workflow/pull/2873))
- Send `x-vercel-queue-region` on proxy-mode queue sends so they route to the correct region's dataplane. ([#2789](https://github.com/vercel/workflow/pull/2789))
- Decode stable-line CBOR structured errors when reading v4 workflow events, while preserving current serialized error payloads. ([#2951](https://github.com/vercel/workflow/pull/2951))
- Fixed observability run/event pages hanging (~16s) with no data in bundled server builds, caused by HTTP/2 requests failing to reach `node:http2`. ([#2632](https://github.com/vercel/workflow/pull/2632))

### Build & framework integrations

- Node.js builtin imports are no longer relativized in step bundles ([#1644](https://github.com/vercel/workflow/pull/1644)); fixed bare-specifier resolution in lazy-discovery step-file copies ([#1670](https://github.com/vercel/workflow/pull/1670)); fixed step bundle discovery and externalization for SDK serde classes ([#1669](https://github.com/vercel/workflow/pull/1669)); fixed a discovery WeakMap cache miss causing duplicate esbuild passes on dev rebuilds ([#1699](https://github.com/vercel/workflow/pull/1699)); fixed `next/package.json` resolution in npm workspaces ([#1701](https://github.com/vercel/workflow/pull/1701)).
- Restored export validation for file-level `"use step"` files ([#1664](https://github.com/vercel/workflow/pull/1664)); eliminated unreferenced private class members after `"use step"` stripping ([#1671](https://github.com/vercel/workflow/pull/1671)); preserved original step function names in stack traces ([#1743](https://github.com/vercel/workflow/pull/1743)).
- Fixed eager Next.js workflow builds with lazy discovery disabled. ([#1747](https://github.com/vercel/workflow/pull/1747))
- Fixed a false-positive `workflow-node-module-error` for step-only Node.js usage in shared modules. ([#1821](https://github.com/vercel/workflow/pull/1821))
- Made the TypeScript peer dependency optional, with a clearer error when unavailable. ([#1830](https://github.com/vercel/workflow/pull/1830))
- Forwarded Nitro `externals.external` string entries to the builder's esbuild config ([#1844](https://github.com/vercel/workflow/pull/1844)); matched the Nitro v3 webhook `functionRules` key to the real handler route ([#1575](https://github.com/vercel/workflow/pull/1575)); externalized the optional `@opentelemetry/api` peer only when not installed, across Rollup and Vite framework builds ([#1947](https://github.com/vercel/workflow/pull/1947)).
- Fixed `Package subpath … is not defined by "exports"` errors when step files reach project-local helpers via tsconfig paths or esbuild aliases. ([#1885](https://github.com/vercel/workflow/pull/1885))
- Fixed duplicate Workflow queue consumers in SvelteKit deployments ([#1995](https://github.com/vercel/workflow/pull/1995)); fixed a SvelteKit production boot crash when a world package pulled `cosmiconfig` into the server bundle ([#2799](https://github.com/vercel/workflow/pull/2799)); avoided recursively loading Vite config while resolving SvelteKit routes ([#2802](https://github.com/vercel/workflow/pull/2802)).
- Fixed `workflow web` for local and postgres backends after the static world-injection change ([#2804](https://github.com/vercel/workflow/pull/2804)); the CLI resolves community world packages when not statically injected ([#2806](https://github.com/vercel/workflow/pull/2806)).
- Fixed detect-mode discovery for object-property step handlers ([#2484](https://github.com/vercel/workflow/pull/2484)); stopped warning on direct workflow calls from workflow code ([#2769](https://github.com/vercel/workflow/pull/2769)); rebuilt deferred Next.js entries on dev recompile ([#2438](https://github.com/vercel/workflow/pull/2438)); added a Windows-safe generated-file writer for step registration output ([#2853](https://github.com/vercel/workflow/pull/2853)).
- Sped up Next.js dev rebuilds, ignored commented imports during HMR discovery, avoided Turbopack resolving custom-world dynamic imports, and filtered Windows `netstat` output by PID when detecting local ports. ([#2678](https://github.com/vercel/workflow/pull/2678))
- `@workflow/ai` preserves provider tool identity across step boundaries. ([#1663](https://github.com/vercel/workflow/pull/1663))
- Clean up temporary Nitro Vite servers and Workflow build contexts after builds. ([#2908](https://github.com/vercel/workflow/pull/2908))
- Dev watcher respects `.gitignore` and a `WORKFLOW_DEV_WATCH_IGNORED_PATHS` env var, avoiding `EMFILE: too many open files` on large monorepos. *(unreleased)* ([#3085](https://github.com/vercel/workflow/pull/3085))
- `discoverWorkflowsInNodeModules` option and `WORKFLOW_DISCOVER_NODE_MODULES` env var stop discovery descending into `node_modules`, skipping the cost of scanning third-party dependencies. *(unreleased)* ([#3054](https://github.com/vercel/workflow/pull/3054))
- Hoisted the `shouldFollowImportsFromFile` check out of `processImportSpecifier` so it is computed once per file instead of once per import specifier. *(unreleased)* ([#3052](https://github.com/vercel/workflow/pull/3052))

### Trace viewer

- Fixed event data loading for `step_created` events ([#1685](https://github.com/vercel/workflow/pull/1685)); fixed stale and mixed data in the span detail panel while navigating ([#2325](https://github.com/vercel/workflow/pull/2325), [#2637](https://github.com/vercel/workflow/pull/2637)); fixed pagination getting stuck on the first page for large runs ([#2200](https://github.com/vercel/workflow/pull/2200)).
- Fixed an `EventRow` crash on spans without `attributes.data`, plus dead-file/JSX/cast cleanup ([#2252](https://github.com/vercel/workflow/pull/2252)); Tailwind v3 compatibility for the encrypted-preview blur utility ([#2108](https://github.com/vercel/workflow/pull/2108)); `Button` hover/focus/radius matched to Geist under Tailwind v3 and v4 ([#2143](https://github.com/vercel/workflow/pull/2143)).
- Fixed duplicate sub-second tick labels and trailing zeros in duration labels ([#2775](https://github.com/vercel/workflow/pull/2775)); fixed middle-truncation rendering ([#2827](https://github.com/vercel/workflow/pull/2827)); span timing uses workflow event occurrence timestamps where available ([#2613](https://github.com/vercel/workflow/pull/2613)).
- Disabled Vite minification for the published web build to avoid false-positive obfuscation flags from supply-chain scanners. ([#1768](https://github.com/vercel/workflow/pull/1768))
- Parse timezone-naive analytics timestamps as UTC so CLI and local web output shows correct times in any timezone. ([#2899](https://github.com/vercel/workflow/pull/2899))
- Animate the zoom controls consistently with span focus. *(unreleased)* ([#3060](https://github.com/vercel/workflow/pull/3060))

---

## ⚪ Internal & Chore

- Refactored `serialization.ts` into modular files, no runtime change. ([#1299](https://github.com/vercel/workflow/pull/1299))
- Renamed `useworkflow.dev` URLs to `workflow-sdk.dev` throughout docs and code. ([#1759](https://github.com/vercel/workflow/pull/1759))
- Simplified the deferred Next.js builder's step-route generation. ([#1796](https://github.com/vercel/workflow/pull/1796))
- Centralized workflow event-type classifiers and event-data payload helpers. ([#2790](https://github.com/vercel/workflow/pull/2790))
- Internal v5 API format separately encoding event metadata from user payloads. ([#2055](https://github.com/vercel/workflow/pull/2055))
- Skipped the abandoned `5.0.0-beta.8/9/10` npm slots left over from an earlier v5 attempt. ([#2168](https://github.com/vercel/workflow/pull/2168))
- Added CI coverage for CLI and web trace-viewer revivers across all serializable types. ([#2250](https://github.com/vercel/workflow/pull/2250))
- Reduced e2e timing and polling flakes ([#2665](https://github.com/vercel/workflow/pull/2665)); fixed a race in `world-testing`'s flow invocation counter causing intermittent inline-execution test failures ([#2043](https://github.com/vercel/workflow/pull/2043)).
- Updated vulnerable dependencies to patched releases. ([#2301](https://github.com/vercel/workflow/pull/2301))
- Bumped `@vercel/queue` 0.3.1 → 0.4.0. ([#2876](https://github.com/vercel/workflow/pull/2876))
- The "Initial v5 beta release" marker changeset, touching every package. ([#1642](https://github.com/vercel/workflow/pull/1642))
- Isolated each spawned test server's data directory, fixing flaky Local World tests where concurrent servers shared one directory and re-enqueued each other's in-flight runs. *(unreleased)* ([#3055](https://github.com/vercel/workflow/pull/3055))
- `WORKFLOW_DISABLE_ANALYTICS_READS=1` opts the world's `analytics` read namespace off, forcing `workflow inspect` list paths onto strongly consistent primary storage — for tests and tooling that read entities immediately after writing them. *(unreleased)* ([#3062](https://github.com/vercel/workflow/pull/3062))
- Added a Stream Overhead (SO) benchmark scenario modelling an LLM token stream, with deterministic variable-length token deltas and an AI-SDK-shaped structured-delta payload variant; collapsed the benchmark PR-comment smallprint into a dropdown. *(unreleased)* ([#3077](https://github.com/vercel/workflow/pull/3077), [#3080](https://github.com/vercel/workflow/pull/3080))
- CI backports only stability fixes to `stable`. *(unreleased)* ([#3092](https://github.com/vercel/workflow/pull/3092))

### Merged without a changeset

These landed on `main` but carry no changeset, so they will not appear in release notes:

- Upgrade postcss to ≥ 8.5.12 (CVE-2026-45623). ([#3067](https://github.com/vercel/workflow/pull/3067))
- Upgrade postcss to ≥ 8.5.18 (GHSA-r28c-9q8g-f849). ([#3102](https://github.com/vercel/workflow/pull/3102))

---

## Excluded: backported to 4.x

108 PRs appear in both lines and are omitted. Six of them were listed in an earlier revision of this document and dropped out when 4.6.1 / 4.6.2 shipped:

- framework base-path routing ([#2732](https://github.com/vercel/workflow/pull/2732))
- `extractStreamIds` stack overflow on circular references ([#2687](https://github.com/vercel/workflow/pull/2687))
- loader sourcemaps in `node_modules` ([#2693](https://github.com/vercel/workflow/pull/2693))
- the custom Next.js `distDir` dev watcher ([#2813](https://github.com/vercel/workflow/pull/2813))
- the `world-testing` vitest peer range ([#2916](https://github.com/vercel/workflow/pull/2916))
- skipping Workflow transforms for generated Nitro artifacts ([#2925](https://github.com/vercel/workflow/pull/2925))

The `next` 16.2.11 CVE-2026-64641 upgrade ([#3071](https://github.com/vercel/workflow/pull/3071)) is merged on `main` but was also backported via [#3073](https://github.com/vercel/workflow/pull/3073) and released in 4.6.2, so it is excluded too.
