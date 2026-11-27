# QuickJS and node:vm performance on spec 9 and spec 10 runs

**Date**: November 2026

This note compares the two workflow VM engines on spec 9 runs (the single orchestrator, `spec9/README.md`): node:vm, the default, and QuickJS, the opt-in WASM engine (`WORKFLOW_VM=quickjs`, see `vm-mode.ts`). It covers time to first step (TTFS), time to resume (TTR) and step-to-step overhead. For each discrepancy between the engines it gives the cause in the code, then suggests how to remove it, because the goal is to make QuickJS the default only once it is at least as fast as node:vm.

Spec 10 (`experimental_rateLimit()`, in review) is a capability-only version on top of spec 9. It runs the same orchestrator, delivery loop and QuickJS entrypoint, so every number here applies to it too. It adds one parity gap of its own (see [Spec 10](#spec-10)).

The numbers come from `spec9/engine-latency.bench.runtime.test.ts` and from standalone scripts run against the built package. [Reproducing](#reproducing) has the commands. Update this note when an engine's hot path changes.

## Summary

| | node:vm | QuickJS | Gap | Main cause |
|---|---:|---:|---|---|
| TTFS, cold process, small bundle | 70 ms | 154 ms | 2.2x | WASM compile, VM boot and baseline heap on the first delivery |
| TTFS, cold process, 1.8 MB bundle | 157 ms | 370 ms | 2.4x | QuickJS parses and evaluates the whole bundle to build the baseline heap |
| TTFS, warm, small bundle | 13.0 ms | 18.1 ms | 1.4x | Baseline heap restore against `vm.createContext()` |
| TTFS, warm, 1.8 MB bundle | 57.9 ms | 35.5 ms | **QuickJS faster** | node:vm re-runs the bundle's top level in each new context |
| Fan-out of 100, first body | 37 ms | 54 ms | 1.5x (1.7x at 10 ms per call) | QuickJS commits background creations and sends their messages before it starts inline bodies |
| Hook resume, 100-step prefix, 1.8 MB bundle | 70.9 ms | 39.0 ms | **QuickJS faster** | node:vm re-runs the bundle; QuickJS restores it |
| Hook resume, 1,000-step prefix (2,003 events) | 67.7 ms | 143.4 ms | 2.1x | Replay costs 2.2 to 2.8x more CPU per event (`evalCode` per event) |
| Hook resume, 2,000-step prefix, snapshot restored, 10 ms per call | 141.7 ms | 95.2 ms | **QuickJS faster** | The snapshot skips replay, but adds 2 serial reads |
| Sleep resume, 1,000-step prefix | 67.1 ms | 155.8 ms | 2.3x (3.4x in an earlier run) | Replay CPU, plus per-turn full-log merges |
| A wake with nothing new (100-step prefix) | 0.4 ms | 22 ms | 55x | QuickJS records no consumed position, so it loads and replays the log |
| Inline step-to-step gap (200 steps) | 5.6 ms | 6.8 ms | 1.2x (1.25x and growing at 10 ms per call) | Same writer and World calls per step; QuickJS does more work per turn |
| Resume while the orchestrator lingers | 7.4 ms | 7.6 ms | ~same (1.4x at 10 ms per call) | Both feed the live VM |

The headline:

1. **A cold QuickJS process is the largest TTFS gap.** It costs between +85 ms (small bundle) and +213 ms (1.8 MB bundle) more than node:vm. Prebuilding the baseline heap at build time removes most of it; that work is already open (see [P0](#p0-cold-start)).
2. **QuickJS replays a log 2.2 to 2.8x slower per event.** TTR on node:vm also grows with history, so the gap grows with it: at 4,000 events it is about 190 ms of CPU per resume. Most of it is host-to-guest string compiles (`evalCode`) that a fixed set of compiled guest functions would replace.
3. **QuickJS lacks node:vm's cheap paths:**
   - the no-op wake (a tail read in place of a full load and replay);
   - the fan-out overlap;
   - in-delivery divergence recovery;
   - the terminal write ahead of a losing inline body;
   - step and resume latency telemetry.

   Each is a port of code that already exists for node:vm.
4. **QuickJS can end up faster than node:vm.** With a large bundle its warm TTFS and its resume on short logs are already lower, because node:vm re-evaluates the bundle on every replay. A restored snapshot already beats node:vm's replay on long logs, despite the reads it adds. A QuickJS VM's whole state also fits in a byte string, which makes the in-process parked-VM resume that node:vm is getting cheaper to build for QuickJS (see [P1](#p1-time-to-resume)).

## Method

**Harness.** `spec9/engine-latency.bench.runtime.test.ts` drives the real queue handler (`workflowEntrypoint`) and delivery loop against the in-memory append-only World (`test-support/append-only-world.ts`), with the in-band fence on.
- Each run is seeded with `executionContext.workflowVm` set to the engine under test, exactly as `start()` stamps it.
- A step body records `performance.now()` at entry.
- Every World call is wrapped to count it and, with `BENCH_RTT_MS`, to delay it. The delay models a remote World's round trip and is not added to the calls that are local on world-vercel (`getEncryptionKeyForRun`, `getDeploymentId`).
- The orchestrator lingers are set to 0, so each resume is a new delivery, except in the linger scenario.

**Bundles.**
- **Small:** only the scenario workflows, a few hundred bytes.
- **1.8 MB:** the `workflowCode` the `workbench/example` build embeds in its flow route (1,821,300 characters: 190 workflows, including the AI SDK). The scenario workflows are appended to it, so each VM pays for evaluating a realistic bundle.

**Cold process.** `scripts/benchmark-engine-cold-start.mjs` runs one turbo first delivery per fresh `node` process against the built package, seven processes per cell. Vitest's module transform inflates the first test of a file, so the harness's own cold row is not used.

**Profiles.** `--cpu-prof` and `node:inspector` profiles of the same deliveries, summarized by self time and inclusive time.

**Machine.** An 8-core Linux devbox, Node 24, quickjs-wasi 3.7.0, `main` at `10f35e334`. Medians unless marked p90; 7 samples after a warm-up for the short scenarios, 3 for the long ones.

**Caveats.**
- The in-memory World answers in microseconds, so with `BENCH_RTT_MS=0` a number is the runtime's CPU on the critical path. The CPU still counts on Vercel: a deployment's function pays it on every delivery.
- `BENCH_RTT_MS=10` gives every remote call the same latency. world-vercel's calls differ (a full load of a long log is several pages; a write is one), so read those rows for call counts and ordering, not absolute time.
- The CPU-only and the added-latency harness runs shared the machine (two processes on 8 cores). Repeated runs moved medians by about 10%, and up to 30% on the sleep scenario.

## How each engine runs a delivery

Both engines share the outer delivery in `spec9/delivery.ts`. That covers spec routing, the terminal-run and no-op checks, turbo setup, `fullLoad()` beside `runs.get`, `run_started`, the deployment guard and the fence-refusal handling. Then node:vm continues in `orchestrate()` in the same file, and QuickJS in `runWorkflowWithQuickJS` (`spec9/quickjs-entrypoint.ts`).

| Phase | node:vm | QuickJS |
|---|---|---|
| Once per process | Compile the bundle to a `vm.Script` (`vm/script-cache.ts`; no V8 code cache). | Base64-decode the embedded WASM (`quickjs-assets.generated.ts`), `WebAssembly.compile` it (`getCompiledAssets`), then build the **baseline heap**: boot a VM, evaluate the bundle, `vm.snapshot()` (`prepareBaselineSnapshot` in `quickjs-runtime.ts`). |
| Overlapped with the log load | Script compilation and payload decryption (`startWorkflowCompile`, `ReplayPayloadCache`). | Nothing: QuickJS setup starts after the load, `run_started` and the dispatch `import()`. |
| Every delivery | `createContext()` (seeded `Math.random`, `Date`, `crypto`, shims), then re-run the bundle's top level in it (`workflow.ts`, span `workflow.bundle.evaluate`). | Restore the baseline heap into a fresh VM (`QuickJS.restore`), re-register host callbacks, install `process.env`. |
| Replay | `EventsConsumer` walks the log in host JS; payloads were already decrypted. | `processEvents` feeds each event through `evalCode` strings (`!!__resolvers[cid]`, resolve and delete, `markCreated`), drains jobs after each one, and re-scans while it makes progress. |
| Across deliveries | Nothing yet (a parked VM is in review, node:vm only). A consumed position lets a wake with nothing new acknowledge after one tail read. | Nothing except the baseline. No consumed position. Past `WORKFLOW_SNAPSHOT_THRESHOLD` (1,000 events), a per-run VM snapshot in the World's `experimental_snapshots` store. |

Within one delivery both engines keep the VM live across inline steps, write responses and live-feed events, so steady-state inline steps cost about the same (see [Step-to-step overhead](#step-to-step-overhead)).

## Measurements

### Time to first step

#### Cold process

`scripts/benchmark-engine-cold-start.mjs`, turbo first delivery: the time from the delivery starting to the step body starting, in a fresh process (median of 7):

| Bundle | node:vm | QuickJS | Difference |
|---|---:|---:|---:|
| Small | 70 ms | 154 ms | +85 ms |
| 1.8 MB | 157 ms | 370 ms | +213 ms |

A profile of the QuickJS 1.8 MB cell breaks it down:

| Phase | Time |
|---|---:|
| Building the baseline heap (`prepareBaselineSnapshot`) | 261 ms |
| Of which: evaluating the bundle | about 240 ms |
| Of which: `vm.snapshot()` | 10 ms |
| Restoring the baseline into the run's VM | 11 ms |
| `QuickJS.create` | 11 ms |
| `WebAssembly.compile` of the runtime and extensions | 6 to 12 ms |
| Base64 decode of the embedded binaries | 11 to 16 ms |

Measured on its own, compiling the 1.8 MB bundle to bytecode (`vm.compile`) takes 150 to 210 ms. **Most of the evaluation is QuickJS parsing the bundle eagerly**, where V8 parses function bodies lazily: node:vm compiles the same bundle in 39 ms, once per process, and then pays about 45 ms per replay to run its top level (see the warm numbers below). quickjs-wasi's host-to-guest string encoding scans every string with a lone-surrogate regex before encoding it (`encodeWtf8`), which takes 12 ms on the 1.8 MB source, where `String.prototype.isWellFormed()` takes 1.9 ms.

The snapshot covers a 12.6 MB heap for the 1.8 MB bundle (1.6 MB for the small one), and restoring it costs 13 to 16 ms (3 ms for the small one).

#### Warm process

The harness, second and later runs in the process (milliseconds, from the delivery starting to the step body):

| | Small: node:vm | Small: QuickJS | 1.8 MB: node:vm | 1.8 MB: QuickJS |
|---|---:|---:|---:|---:|
| Turbo first delivery | 11.1 ms | 16.4 ms | 62.8 ms | 24.6 ms |
| First delivery without turbo | 13.0 ms | 18.1 ms | 57.9 ms | 35.5 ms |

- **Small bundle:** QuickJS is about 5 ms slower. That is its fixed per-delivery cost: the baseline restore (about 3 ms) and its per-run `evalCode` setup, against node:vm's `createContext()` (about 0.7 ms).
- **1.8 MB bundle:** node:vm is slower. Every node:vm replay runs the bundle's top level in a new context, which costs about 45 ms for this bundle (57.9 against 13.0 ms), while QuickJS restores the evaluated heap in 13 to 16 ms. The node:vm cost is per *cold replay*, so it also lands on every resume delivery (see below).
- **World calls:** both engines make the same remote calls before the first body. Without turbo that is `runs.get` beside `events.list`, `run_started`, a second `events.list`, then the inline `step_started`. With turbo it is `run_started` in the background, then `step_started`. QuickJS adds one local `getEncryptionKeyForRun`: it derives the key again instead of reusing the delivery's memoized one.

#### Fan-out

`Promise.all` over 100 steps; 10 run inline and 90 as background steps, all on one delivery:

| | node:vm | QuickJS |
|---|---:|---:|
| First body, no added latency | 37 ms | 54 ms |
| First delivery, no added latency | 42 ms | 61 ms |
| First body, 10 ms per call | 81 ms | 141 ms |

The ordering difference the spec 9 README records under "Fan-out order":
- **node:vm** puts the inline steps' starts in the first creation batch and starts their bodies once that batch commits (or before, on turbo), while the background creations and their step messages go out beside them.
- **QuickJS** (`dispatchPendingOps` in `quickjs-pending-ops.ts`) first writes every background `step_created` batch and sends those step messages. It then runs one extra VM turn to feed them in, and only then launches the inline bodies.
- **On a non-inert boundary**, QuickJS also writes each inline start as its own write, and the writer serializes them. So N inline starts cost N round trips where node:vm pays one batch.

### Step-to-step overhead

Sequential inline steps in one delivery (gap between consecutive step bodies, milliseconds):

| Steps | node:vm | QuickJS | Note |
|---|---:|---:|---|
| 200 | 5.6 | 6.8 | 3.0 World calls per step on both |
| 2,000, first tenth | 5.4 | 6.9 | |
| 2,000, last tenth | 12.1 | 11.5 | growth with the log, on both |
| 200 at 10 ms per call, first tenth | 5.8 | 6.4 | run-ahead coalesces writes: 1.63 calls per step on node:vm, 1.75 on QuickJS |
| 200 at 10 ms per call, last tenth | 6.5 | 9.5 | |

Without added latency the engines are within 20% of each other. Both keep the VM live, write `step_started` and the outcome through the same in-band writer, and feed the outcome in without a reload. Both also slow down as the log grows, which is the orchestrator's own per-write work (spec 9 follow-up 6, `log-growth.bench.runtime.test.ts`).

With 10 ms per call, run-ahead hides the write latency on both, but less of it on QuickJS:
- QuickJS makes 7% more calls per step.
- Its gap grows from 6.4 to 9.5 ms over 200 steps, where node:vm's stays near 6 ms.

The cause is not isolated here. The suspects are the per-turn work over the whole log (below) and a run-ahead that drains more often.

### Time to resume

#### Hook resume on a new delivery

The workflow runs an N-step prefix inline, awaits a hook, and runs one step after it. `resumeHook()` writes `hook_received` and sends the wake, and the wake is delivered (milliseconds from that delivery's start to the step body; small bundle, no added latency):

| Prefix (log events) | node:vm | QuickJS | QuickJS/node:vm |
|---|---:|---:|---:|
| 0 (3) | 12.9 | 15.8 | 1.2x |
| 10 (23) | 12.8 | 17.9 | 1.4x |
| 100 (203) | 19.2 | 32.1 | 1.7x |
| 500 (1,003) | 39.9 | 83.6 | 2.1x |
| 1,000 (2,003) | 67.7 | 143.4 | 2.1x |
| 2,000 (4,003) | 118.6 | 310.2 | 2.6x |

Both engines load the whole log and replay it from the top in a new VM, so TTR grows linearly with history on both: about 0.026 ms per event on node:vm and 0.074 ms on QuickJS (an earlier run measured 0.031 and 0.069). The World calls on the critical path:
- **node:vm (7 calls):** a tail read (the no-op check), `runs.get` beside `events.list`, then the creation write.
- **QuickJS (6 calls):** the same without the tail read, because it has no consumed position to check against.

A profile of a 2,003-event QuickJS replay (150 ms) puts 136 ms in `processEvents`. Of that:
- **94 ms is `evalCode`.** That covers encoding each source string into WASM memory (about 27 ms, `encodeWtf8` and `TextEncoder`), parsing and compiling it in the guest, and running it.
- **21 ms is draining jobs** (`executePendingJobs`).

A profile of the same replay on node:vm (69 ms) is dominated by devalue deserialization. That includes rebuilding the reviver tables for every payload (`getCommonRevivers`, `getReviversForMode`, `getStepFunctionReviver`: about 8 ms), a cost node:vm could drop too.

With the 1.8 MB bundle, node:vm pays about 40 ms more per resume to re-run the bundle, so QuickJS is faster on short logs and slower past a few hundred steps (no added latency):

| Prefix | node:vm | QuickJS |
|---|---:|---:|
| 0 | 50.4 | 26.7 |
| 100 | 70.9 | 39.0 |
| 500 | 77.0 | 90.8 |
| 1,000 | 119.3 | 150.8 |
| 2,000 | 191.1 | 260.0 |

With the 1.8 MB bundle and 10 ms per call, with snapshots on (QuickJS):

| Prefix | node:vm | QuickJS | Snapshot restored |
|---|---:|---:|---|
| 0 | 71.1 | 39.8 | no (below the threshold) |
| 100 | 79.5 | 49.2 | no (below the threshold) |
| 1,000, resumed at once | 128.9 | 178.1 | no: the save, which runs after the delivery returns, had not finished |
| 1,000, resumed 1.5 s later | 126.2 | 121.0 | yes |
| 2,000, resumed 1.5 s later | 178.6 | 166.5 | yes |

#### Snapshots

On a World with `experimental_snapshots`, QuickJS saves a VM snapshot at a suspension once the log passes `WORKFLOW_SNAPSHOT_THRESHOLD` (1,000 events by default), and restores it on the next delivery instead of replaying. It saves replay CPU, but it does not save a round trip:
- `delivery.ts` has already loaded the whole log before it dispatches to QuickJS.
- The restore then adds a serial `snapshots.load`.
- It then reads the delta after the snapshot's cursor again with `listRunLogFrom` (`quickjs-entrypoint.ts`), although the delta is in the log it was handed.

That costs two or more serial round trips more than a replay. The save also runs after the delivery returns (snapshot, compress, encrypt, store), so a resume that lands soon after a suspension misses it and replays in full (the 1.8 MB table above). On world-vercel the snapshot is one more request, and the bytes are decrypted and decompressed on the critical path. With snapshots on and 10 ms per call (small bundle):

| Prefix | node:vm | QuickJS | QuickJS World calls before the body |
|---|---:|---:|---|
| 1,000 (2,003 events) | 86.9 | 78.5 | 9: `snapshots.load` and two delta `events.list` reads added, no tail read |
| 2,000 (4,003 events) | 141.7 | 95.2 | 9 |

Open #4706 removes the delta re-read and prefetches the snapshot. It targets the QuickJS entrypoint's resume path and needs porting to the spec 9 entrypoint.

#### Sleep resume

The same prefix, then `sleep('1s')`, then a step. The timer's delivery runs to the step body (milliseconds, small bundle, no added latency):

| Prefix | node:vm | QuickJS |
|---|---:|---:|
| 0 | 12.5 | 17.3 |
| 100 | 19.5 | 29.3 |
| 1,000 | 67.1 | 155.8 |

The gap was 2.3x at 1,000 steps in the final run and 3.4x in an earlier one, against 2.1x for a hook. On top of the replay, QuickJS:
- completes each elapsed wait with its own awaited write before the VM boots;
- builds `fullLog()` (a merge and sort of the whole log) on every loop turn, because `armChainsBeforeCompletion(fullLog(), …)` evaluates its argument even when no wait elapsed. It also builds it for `logStepStates()` and `externalWorkOfPass()`.
- on a restored snapshot, reads the log twice more after its own `wait_completed`. That is 11 World calls before the body against node:vm's 6, and 151 ms against 115 ms with the 1.8 MB bundle at 10 ms per call.

#### Resume while the orchestrator lingers

When the hook payload lands within the orchestrator's linger window, both engines take it from the live feed into the running VM: 7.4 ms on node:vm against 7.6 ms on QuickJS, from `resumeHook()` to the step body. That is the fast path a resume gets when it lands while the run's orchestrator is still running, on either engine.

#### A wake with nothing new

A wake for a run whose log has not moved since the last suspension. These are a leftover sleep timer, a wake whose event a lingering delivery already consumed, and a coalesced re-run:

| | node:vm | QuickJS |
|---|---:|---:|
| Time, 100-step prefix | 0.4 ms | 22 ms |
| Time, 100-step prefix, 1.8 MB bundle | 0.4 ms | 33 ms |
| Time, 100-step prefix, 10 ms per call | 21 ms | 44 ms (53 ms with the 1.8 MB bundle) |
| World calls | 2 (`runs.get`, a one-event tail read) | 4 (`runs.get`, a full `events.list`, 2 local key derivations) |

node:vm records the slot it consumed at a clean suspension (`recordConsumedPosition`, `spec9/consumed-position.ts`) and acknowledges such a wake after one `events.list` of the tail. QuickJS records none, so it loads the whole log and replays it, and the run's next real wake queues behind that delivery. The check itself already runs for both engines in `delivery.ts`; only the recording is node:vm-only.

## Discrepancies

What QuickJS does differently on a spec 9 run, by effect. The first group costs latency; the second is behaviour that has to match before QuickJS can be the default.

**Latency:**

1. **Cold start.**
   - Every process compiles WASM and builds the baseline heap.
   - It does this on the first delivery's critical path, after the log load, with nothing overlapped.
   - A bundle whose module scope reads the clock or draws randomness is ineligible for the baseline, and then every delivery evaluates it. A harness run whose 1.8 MB bundle failed the gate spent about 145 ms of every delivery on that evaluation, against 35 ms on node:vm.
2. **Replay CPU per event.** 2.2 to 2.8x node:vm's, from `evalCode` per event, the job drain per event and the fixed-point re-scan in `processEvents`. Payloads are decrypted one at a time inside the scan, where node:vm decrypts them while the log loads.
3. **Per-turn work that grows with the log.**
   - `fullLog()` is rebuilt and sorted on every loop turn.
   - `analyzeLogSteps` runs over the full log.
   - `beginTerminalInertBatch` builds a JSON string of every correlation id in the batch.
4. **No consumed position.** A wake with nothing new costs a full load and replay instead of one tail read.
5. **Snapshot restore adds reads.** It adds a snapshot load and a delta re-read on top of the full load.
6. **Fan-out ordering.** Inline bodies start after the background creations and step messages, and inline starts are separate serialized writes on a non-inert boundary.
7. **Its own key derivation.** `getEncryptionKeyForRun` is called again rather than reusing the delivery's memoized key. It is local on world-vercel; on a World where it is remote it is a round trip.
8. **Clock rule.** QuickJS advances the VM clock to every event it reads, where node:vm advances it only when an event reaches workflow code. A workflow that reads the clock while run-ahead holds an unconfirmed speculative event therefore loses run-ahead on its next boundary (the "clock gate"), so it waits for each outcome.
9. **Run-ahead repair.** A speculative write another writer displaced restarts the QuickJS delivery, where node:vm repairs it in place.

**Behaviour:**

10. **Race losers.** QuickJS waits for a losing inline step body (and speculative writes) to settle before it writes `run_completed` or `run_failed`. node:vm writes the terminal event first. A run won by a hook or sleep against a long inline step completes only when that step does: a completion latency up to the step's duration.
11. **No replay-divergence recovery.** A divergence fails the run, where node:vm reloads and replays up to `WORKFLOW_REPLAY_DIVERGENCE_MAX_RETRIES` times.
12. **Inline-start margin.** Inside the margin, an inline step an earlier delivery left open still runs once per delivery on QuickJS, where node:vm leaves it unstarted.
13. **Telemetry.**
    - QuickJS's `executeStep` call passes no `latencyTracking` or `resumeTracking`, so `step.ttfs_ms`, `step.stso_ms`, `step.rsfs_ms` and the `workflow.resume.*` phases are missing on QuickJS runs. That includes the copies attached to terminal step events.
    - Only QuickJS sets `workflow.vm`, so node:vm spans have no engine tag.
    - QuickJS has no span attribute for WASM compile, baseline hydrate or restore, VM boot or replay time; `workflow.quickjs.snapshot.restore_ms` covers only the snapshot load and decode.

### Spec 10

`experimental_rateLimit()` is implemented on node:vm only in its pull request: the QuickJS bootstrap installs a `WORKFLOW_RATE_LIMIT` that rejects with "not available in the QuickJS workflow engine yet". A spec 10 run on QuickJS can therefore not use the feature spec 10 exists for. QuickJS needs its own rate-limit handling, or the shared `rate` open-wait path, before it can be the default there. The rate wait itself reuses the wait-timer machinery, so its latency profile is that of a sleep (see [Sleep resume](#sleep-resume)).

## Suggestions

Ordered by what they remove from TTFS and TTR. Each lists the expected effect from the measurements above.

### P0: cold start

1. **Ship the baseline heap with the build** (open #4945, #4946, #4960).
   - The builder evaluates the bundle in QuickJS once and ships the heap as a file next to the flow route. #4960 measured 215 ms to 23 ms on the nextjs-turbopack workbench.
   - This removes the 260 ms hydrate measured here for a 1.8 MB bundle.
   - It is the single largest TTFS item.
2. **Ship the WASM as files and compile them before the first delivery.**
   - Load the `.wasm` files with the same `loadAsset` mechanism, not as base64 in the route module: that saves the decode and keeps a 1.4 MB string out of the JS parse.
   - Start `getCompiledAssets()` and the baseline load when the flow route module evaluates, when QuickJS is the configured engine, or at least as soon as a delivery knows its run is a QuickJS run, overlapped with `fullLoad()` and `runs.get` as `startWorkflowCompile` does for node:vm.
   - This also matters for start and resume deliveries that run in the calling route (open #5365): there, the route that called `start()` would pay the QuickJS cold start too.
3. **Precompiled bytecode as the fallback.** Where a prebuilt heap is not available, the bundle is ineligible, or the heap file fails its check, evaluate bytecode the build compiled (`vm.compile` and `evalBytecode` in quickjs-wasi) instead of source. Parsing is 150 to 210 ms of the 240 ms evaluation for the 1.8 MB bundle. Bytecode is about 1.9x the source size (3.4 MB), and is keyed by the quickjs-wasi version like the snapshot format.
4. **Upstream: `isWellFormed()` in quickjs-wasi's `encodeWtf8`.** `String.prototype.isWellFormed()` is native and about 6x faster than the lone-surrogate regex. It saves about 10 ms per evaluation of a 1.8 MB source, plus a share of every host-to-guest string.

### P1: time to resume

5. **Replace per-event `evalCode` with compiled guest functions.**
   - Compile a small fixed set of guest functions once per VM (or bake them into the baseline heap), such as `deliverStepResult(cid, value)`, `deliverHook(cid, value)`, `hasResolver(cid)` and `markCreated(cid, kind)`.
   - Call them with `callFunction` and handles, so a replay compiles no source per event.
   - Better still, move the replay loop into the guest: one call per batch, with an array of events and pre-deserialized payload handles, so the host↔guest crossings per event are constant and small.
   - The profile puts about 94 ms of a 150 ms 2,003-event replay in `evalCode`, so this should bring QuickJS replay to node:vm's cost or below.
   - Drop the debug-argument construction on the hot path too (`new TextDecoder().decode(...)` inside `runtimeLogger.debug` arguments runs whether debug is on or not).
6. **Record the consumed position on QuickJS.** Call `recordConsumedPosition` at a QuickJS clean suspension with the maximum slot the VM consumed and `nextTimerAt`, as `orchestrate()` does. The check in `delivery.ts` already applies to both engines. This turns a wake with nothing new from 22 ms (33 ms with the 1.8 MB bundle) into one tail read, and the run's next wake no longer queues behind a pointless replay.
7. **Park the suspended VM in the process.** node:vm is getting this in open #5467: the next plain wake in the same process reads only what landed since, and resumes the parked VM. QuickJS can do the same more cheaply and with a bounded memory cost:
   - keep the live VM (a few MB of WASM memory) for a short window;
   - or `vm.snapshot()` it after the response (10 ms for a 12.6 MB heap, off the critical path) and keep the bytes in an LRU keyed by run and in-band count.
   - On the next wake, check the tail as #5467 does, restore (3 to 16 ms) and feed only the delta.

   This makes QuickJS TTR flat in history on a warm instance, where node:vm today pays about 0.03 ms per event plus the bundle re-run. Chat-style runs that loop on a hook (one resume per user message, usually after the linger window) gain the most.
8. **Fix the snapshot restore's reads.**
   - **Overlap the probe:** start `snapshots.load` beside `fullLoad()`, or before it when this process saw the run past the threshold (#4706's latch).
   - **Slice, don't re-read:** take the delta from the log `delivery.ts` already loaded instead of `listRunLogFrom`.
   - **Skip the full load:** with a usable snapshot, load only the tail after its cursor, which makes the load O(delta) instead of O(history). This is the change that makes snapshots pay for themselves on world-vercel; today they save only replay CPU and add round trips.
   - **Close the save window:** a resume that lands before the post-response save finishes replays in full. Keeping the latest snapshot in the process (item 7) covers a resume that lands in the same instance.
   - **Stop re-reading after `wait_completed`:** on a restored snapshot, a timer resume lists the log twice more after its own write.
9. **Stop rebuilding the full log on every loop turn.** Keep the merged, sorted log incrementally (events arrive in slot order), and build `fullLog()` only when a wait actually elapsed.

### P1: time to first step on fan-outs

10. **Port node:vm's fan-out ordering.** Put the inline starts in the first creation batch and start their bodies when it commits (or optimistically, on turbo), with the background creations and step messages going out beside it. Use one creation batch for the inline starts of a non-inert boundary instead of one serialized write each. That removes the first-body gap measured here (1.5x, or 1.7x at 10 ms per call) and the N serial writes on a remote World.

### P2: parity that affects latency or completion

11. **Write the terminal event before a losing inline body settles**, as node:vm does. The loser's outcome, if it lands, follows the terminal event and is inert.
12. **Align the clock rule with node:vm.** Advance the VM clock only when an event reaches workflow code, the follow-up the comment in `processEvents` names. That removes the clock gate, so workflows that read the clock keep run-ahead.
13. **Repair a displaced speculative write in place** instead of restarting the delivery, as node:vm does.
14. **In-delivery divergence recovery**: discard the VM, reload and replay from the baseline, up to `WORKFLOW_REPLAY_DIVERGENCE_MAX_RETRIES`.
15. **Rate limits on QuickJS** before spec 10 can default to QuickJS.
16. **Reuse the delivery's encryption key** instead of deriving it again.

### P0 for the rollout: measure both engines the same way

17. **Pass `latencyTracking` and `resumeTracking` into QuickJS's `executeStep`.** Without them, production TTFS, STSO and TTR for QuickJS runs cannot be compared with node:vm.
18. **Tag `workflow.vm` on every span**, `node` included, so a dashboard can group by engine without inferring node:vm from a missing value.
19. **Add QuickJS phase attributes** to the delivery span: WASM compile, baseline (`prebuilt`, `hydrated`, `cached` or `ineligible`, and its time), VM restore, replay time and events replayed. Make `snapshot.restore_ms` cover the VM restore and delta replay, or add a separate attribute for them.
20. **Benchmark both engines in CI.**
    - Add a `vm: [node, quickjs]` dimension to `benchmarks.yml` on a spec 9 deployment.
    - Add a TTR scenario to `workflows/97_bench.ts`: N steps, then a hook resumed after the linger, timed from `resumeHook()` to the next step body.
    - Run the engine-latency harness here on demand.

### Suggested order

1. **Telemetry (17 to 19)**, so that production can confirm each step.
2. **The prebuilt baseline and WASM prewarm (1 and 2).** These close most of the cold TTFS gap.
3. **Compiled guest functions (5), the consumed position (6) and the per-turn log work (9).** These close the warm resume gap, and are each contained in the QuickJS files.
4. **Fan-out ordering (10) and the snapshot reads (8).**
5. **The parked VM (7).** It is the change that would make QuickJS faster than node:vm on resume.
6. **The parity items (11 to 16)**, before the default changes.

### node:vm items found on the way

These are not QuickJS gaps, but the same measurements show them:
- node:vm re-runs a large bundle's top level on every cold replay (about 45 ms for 1.8 MB), and compiles without a V8 code cache (39 ms per process).
- Its deserialization rebuilds reviver tables per payload.

The first is why QuickJS is already faster warm on large bundles. It also makes the parked VM (#5467) worth more on node:vm than the replay numbers alone suggest.

## Reproducing

The harness is opt-in:

```bash
cd packages/core
WORKFLOW_ENGINE_BENCH=1 pnpm vitest run src/runtime/spec9/engine-latency.bench.runtime.test.ts
```

Its knobs are documented at the top of the file:
- `BENCH_ENGINES`
- `BENCH_RTT_MS`
- `BENCH_BUNDLE`
- `BENCH_SNAPSHOTS`
- `BENCH_ITERATIONS`
- `BENCH_LOG_SIZES`
- `BENCH_RESUME_DELAY_MS`
- `BENCH_OUT`

**To get a realistic bundle:**
1. Build `workbench/example` (`pnpm build`).
2. Extract the template literal assigned to `workflowCode` in `.vercel/output/functions/.well-known/workflow/v1/flow.func/index.mjs` into a file.
3. Pass that file as `BENCH_BUNDLE`.

**Cold-process numbers** come from a fresh `node` process per run, against the built package:

```bash
pnpm turbo run build --filter=@workflow/core
cd packages/core
node scripts/benchmark-engine-cold-start.mjs --runs 7 [--bundle <workflowCode.js>]
```

Each process seeds one run on `AppendOnlyWorld` (from `dist/test-support`) and delivers a start message that carries `runInput`, which makes it a turbo first delivery.

**Profiles** of a replay or a cold start can be taken the same way, with `node --cpu-prof` or `node:inspector` around one delivery.
