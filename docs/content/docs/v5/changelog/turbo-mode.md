---
title: Turbo mode (fast first invocation)
description: Fast-path the first delivery of a run by backgrounding run_started, skipping the initial event-log load, and starting the first inline steps before their start commits, on spec 8 and spec 9 runs. A no-op for everything else.
---

# Turbo mode

Turbo mode changes only the first delivery of a run's first orchestrator message; every other delivery takes the normal path. Both orchestrators have it, and each implements it its own way: spec 8 runs, the default for new runs, take the path in [Spec 8 runs](#spec-8-runs), and runs on the opt-in [single orchestrator](/docs/changelog/single-orchestrator) model (spec version 9, `WORKFLOW_SPEC_VERSION=9`) the one in [Spec 9 runs](#spec-9-runs). `WORKFLOW_TURBO=0` turns both off.

## Motivation

The first invocation of a workflow run is where time-to-first-step matters most, yet it pays the most fixed network latency before any user code runs. Without turbo, these round-trips sit in front of the first step body of a spec 9 run:

1. **The event log is loaded**, together with the in-band fence count, and the run is read, before anything is written.
2. **`run_started` is awaited**, and the log is loaded again to pick it up.
3. **The first step's `step_created` and `step_started` are awaited** before its body runs.

On the first delivery none of them can change what the orchestrator decides: the log holds only `run_created`, the fence count after the run's creation is known, and no other orchestrator of the run can exist yet. Turbo mode removes all three for that delivery only.

The spec 8 orchestrator removes the same costs with what it has: it backgrounds `run_started`, skips the first log load, and forces [optimistic inline start](./lazy-event-creation#optimistic-inline-start-opt-in-off-by-default), which is off by default on spec 8 because two handlers of a run can both run a body under contention.

## Spec 9 runs

### What turbo mode does

When the handler detects the first delivery of the first message, it:

1. **Backgrounds `run_started`.** The event goes out without waiting, through the delivery's in-band writer, and the run is synthesized locally from the queued run input (status `running`, `startedAt` now), so replay begins immediately. This reuses the [resilient start](./resilient-start) contract: a `run_started` carrying the run input creates the run when `run_created` never landed. Because turbo uses this `run_started` as a write barrier and never reads its response's log page, it asks the World to **skip the `run_started` event-log preload**. A World that ignores the hint stays correct.
2. **Skips the initial event-log load.** The first replay runs against an empty log. The in-band writer starts from the fence count right after the run's creation (`run_created` counts as the run's first in-band position), which is the count a load would have returned. The responses of the delivery's own writes, `run_started` included, fold their events and skipped-slot reports into the log, so the next pass usually needs no load either.
3. **Starts inline step bodies before their start commits** (optimistic inline start). The first step's `step_created` and `step_started` go out in one batch write behind `run_started`, and the body runs while they are in flight. Its outcome is written only after its start committed.

The first step body starts after the in-process replay, with `run_started`, `step_created` and `step_started` written in the background around it and no `events.list` before it.

### Why this is safe (and where it stops)

#### Detection

The first message is the only one that carries the queued **run input**. Turbo engages when it does, its delivery count is 1 (a redelivery, including the one after a fence refusal, counts higher), and the delivery is not a background step, a divergence recovery, a hook resume or a timer.

#### One orchestrator, one writer

Starting a body before its start commits is unsafe in general: if the in-band fence then refuses the start because another orchestrator invocation of the run holds it, the body ran without a durable record and runs again. On the first delivery of the first message there is no other orchestrator yet: the run was created moments ago by `start()`, and this one message is the only one in flight. The body therefore runs once.

#### Turbo stops on the first hook or wait

A hook or a wait gives the run writers other than this delivery (a hook resume, a timer, `wakeUp()`), each of which wakes the orchestrator. Turbo stops starting bodies ahead of their start for the rest of the delivery as soon as a suspension has a hook or a wait. Later inline steps of that delivery wait for their start to commit, as on every other delivery. Attribute writes resolve in this process and do not end it.

#### Every write still lands after `run_started`

- Every in-band write of the delivery goes through one in-band writer, which serializes them. `run_started` is the first, so `step_created`, `step_started`, `wait_created`, hook events and the run's terminal event all queue behind it. The log still reads `run_created → run_started → step_created → step_started → step_completed`.
- Writes made outside the in-band writer by an optimistic step body wait on the run-ready barrier: stream writes through `getWritable()`, a writable stream passed as a step argument, a stream the step returns, and `setAttributes()`.
- An awaited start (with `WORKFLOW_OPTIMISTIC_INLINE_START=0`) also waits for `run_started` before it is sent.

#### When `run_started` or a later write is refused

If the backgrounded `run_started` fails for any reason, a definite refusal included, the in-band writer stops: nothing else this delivery would write reaches the World, and no further inline body starts. Bodies that already started settle first, their outcomes are discarded, and the delivery ends as an awaited `run_started` failing the same way would end it:

- refused by the in-band fence (`InBandSupersededError`): redelivered about a second later instead of acknowledged; the redelivery is not a first delivery, so it loads the log and takes the normal path;
- the run already finished (for example cancelled before its first delivery): acknowledged with nothing written;
- anything else: retried by the queue, or recorded as a setup failure.

Stream and attribute writes waiting on the barrier fail instead of writing, so a refused start leaves no chunks or attributes on a run whose log does not record the step that made them. A body that ran before such a refusal does run again on the redelivery.

The same holds for the step's own start: if its batch is refused, the body's outcome is not written, and the start's error decides (a throttle defers the run, a finished run ends the delivery, anything else fails it).

#### A run cancelled before its first delivery still runs the first step body

The normal path loads the run up front and returns before any workflow or step code runs if the run was cancelled or expired between `start()` and this delivery. Turbo synthesizes `status: 'running'` and runs the first step body before `run_started` returns, so the cancellation is only observed when `run_started` is refused, after the body's side effects ran. `WORKFLOW_TURBO=0` restores the up-front check.

#### `workflowStartedAt` reflects the first delivery's clock

Replay matching (step, wait and hook correlation IDs, the VM seed, and the in-VM `Date.now()`) is derived from a replay-stable timestamp recovered from the run ID, so it does **not** depend on `startedAt` and is identical on every delivery. The one value that still tracks `startedAt` is the user-facing `getWorkflowMetadata().workflowStartedAt`: under turbo the first delivery synthesizes it from the local clock, while a later delivery reads the World's `startedAt`, so the two can differ by the start-to-first-delivery latency. Treat `workflowStartedAt` as an approximate, human-facing timestamp, and do not branch workflow control flow on it. For timing logic that must survive replay, use the in-VM `Date.now()` / `new Date()`.

#### Attributes seeded at `start()` survive the skipped event load

`start({ attributes })` does **not** disable turbo. Seed attributes are folded into the `run_created` event's data and ride along in the queued run input, so the synthesized run carries them. This is safe because **attributes are write-only inside a workflow**: there is no in-workflow read API, and `run_created` is consumed structurally during replay. If an in-workflow attribute *read* API is ever added, it MUST read from the run snapshot (which turbo populates from the run input), not by replaying `run_created` / `attr_set` events, or it would see no seed attributes on the first turbo delivery only.

### Configuration

Turbo mode is **on by default**. Set `WORKFLOW_TURBO=0` (or `false`) to disable it: every delivery then loads the log, awaits `run_started`, and waits for each inline step's start to commit before its body runs. Use it for deployments whose first-step bodies are not idempotent, or to isolate behavior while debugging.

`WORKFLOW_OPTIMISTIC_INLINE_START=0` (or `false`) keeps turbo's backgrounded `run_started` and skipped initial load, and makes the first delivery's inline bodies wait for their start to commit. No other value of it does anything: on single-orchestrator runs there is no optimistic inline start outside turbo's first delivery, because only that delivery is known to have no other orchestrator.

Turbo mode is client-side and needs no World changes. A World with `createBatch` saves the separate `step_started` write; one without it gets the start as its own write, chained behind `step_created`.

## Spec 8 runs

This is the spec 8 orchestrator's turbo path (`isTurboEnabled()` in `runtime/spec8/delivery.ts`), unchanged by spec 9.

### What turbo mode does

When the handler detects the first delivery of the first invocation, it:

1. **Backgrounds `run_started`.** The event is written without awaiting; the run entity is synthesized locally from the queued run input (status `running`, `startedAt` now) so replay can begin immediately. The `run_started` round-trip overlaps replay instead of blocking it. This reuses the [resilient start](./resilient-start) contract: `run_started` carrying the run input creates the run on the fly (synthetic `run_created`) if it doesn't exist yet. Because turbo uses this `run_started` purely as a write barrier and never reads its response, it also asks the World to **skip the `run_started` event-log preload** (the list+resolve the World normally returns so a run can skip its first `events.list`). That preload would be wasted work here. Since the first `step_started` is chained on the `run_started` barrier, trimming the `run_started` request directly shortens the wait before the first durable `step_started` (and therefore time-to-second-step). A World that ignores the hint stays correct; the runtime falls back to `events.list` if it ever needs the log.
2. **Skips the initial event-log load.** Nothing has been written, so the first replay runs against an empty log. The second loop iteration does a normal incremental load once the first step's events exist.
3. **Forces optimistic inline start** for that invocation, independent of `WORKFLOW_OPTIMISTIC_INLINE_START`. The step body runs immediately against locally-synthesized state; only the `step_started` network write waits for the backgrounded `run_started`.

The first step body starts after the in-process replay, with `run_started` and `step_started` happening in the background around it and no `events.list` before it.

### Why this is safe (and where it stops)

#### Detection

The first-invocation message is the only one that carries the queued **run input**, and the queue delivery **attempt is 1** (a redelivery is attempt ≥ 2). Together with "not a background-step invocation" and "not a divergence recovery", that uniquely identifies the first delivery of the first invocation without a new message field or world/backend change.

#### The single-handler guarantee

Forcing optimistic start is unsafe *in general* because two handlers racing the same step's create-claim can both run the body before one wins. On the first delivery of the first invocation there is **no concurrent peer handler**. The run was created moments ago by `start()`, and only this one message is in flight. The body therefore runs exactly once, and forcing optimistic start is safe here even though the global flag is off.

#### Turbo exits on the first hook or wait

That single-handler guarantee ends the moment the run creates a **hook** or **wait** (or writes attributes) because those introduce later resume/parallel invocations that *can* race. Turbo stops forcing optimistic start as soon as a suspension creates any of them. The inline steps of that suspension fall back to the normal await-then-run path, and the rest of the run behaves exactly as it does today. A pure-step suspension (the common hot path) stays on the fast path.

#### Write ordering is preserved

Because `run_started` is backgrounded, every event write is gated on a run-ready barrier so nothing is written before the run exists:

- The optimistic `step_started` is **chained** on the barrier. The body still runs immediately; only the network write waits.
- The suspension handler **awaits** the barrier before any eager write (`hook_created`, `wait_created`, overflow `step_created`). The pure inline hot path defers all its steps and writes nothing here, so it never blocks on the barrier.
- Terminal run writes (`run_completed` / `run_failed`) await the barrier too, so a workflow that finishes with no steps still orders its completion after `run_started`.

The event log therefore still reads `run_created → run_started → step_created → step_started → step_completed`. If the backgrounded `run_started` genuinely fails (e.g. the run was canceled in the meantime), the chained writes surface the real error (`gone` / run-not-found) and the message redelivers as a normal, non-turbo attempt.

The barrier orders **event** writes. The forced-optimistic first step **body** runs immediately, so any side effects it performs *before* the terminal write (stream writes via `getWritable()` and the per-step ops flush) are **not** gated on the barrier and can reach the world before the backgrounded `run_started` lands (and are orphaned if it ultimately fails). This is the same exposure as optimistic inline start and is covered by the stream-safety caveat below; deployments whose first step writes to the workflow stream and require strict `run_created → run_started` ordering of stream data should set `WORKFLOW_TURBO=0`.

#### A run cancelled before its first delivery still runs the first step body

The non-turbo path awaits `run_started` up front and, if the run was canceled or expired between `start()` and this delivery, returns before any workflow/step code runs. Turbo synthesizes `status: 'running'` and runs the first step body optimistically, so such a cancellation is only observed when the backgrounded `run_started` (and the barrier-chained `step_started`) rejects, *after* the body's side effects have executed (they are then discarded via reconciliation). For non-idempotent first steps this is the same "body runs before ownership is confirmed" tradeoff as optimistic inline start; `WORKFLOW_TURBO=0` restores the up-front skip.

#### `workflowStartedAt` reflects the first delivery's clock

Replay matching (step/wait/hook correlation IDs, the VM seed, and the in-VM `Date.now()`) is derived from a replay-stable timestamp recovered from the run ID, so it does **not** depend on `startedAt` and is identical on every delivery. The one value that still tracks `startedAt` is the user-facing `getWorkflowMetadata().workflowStartedAt`: under turbo the first delivery synthesizes it from the local clock, while a later (non-turbo) delivery loads the server-canonical `startedAt`, so the two can differ by the start→first-delivery latency. Treat `workflowStartedAt` as an approximate, human-facing timestamp. **Do not** branch workflow control flow on it (e.g. `Date.now() - +workflowStartedAt > threshold`), since that can take different paths across deliveries and diverge on replay. For timing logic that must survive replay, use the in-VM `Date.now()` / `new Date()`, which is replay-stable.

#### Attributes seeded at `start()` survive the skipped event load

`start({ attributes })` does **not** disable turbo, and it needs no synthetic event in the empty log. Seed attributes are folded into the `run_created` event's data (not separate `attr_set` events) and ride along in the queued run input, so the locally-synthesized run snapshot carries them. Turbo loses nothing by skipping the initial `events.list`.

This is safe specifically because **attributes are write-only inside a workflow**: there is no in-workflow read API today, and `run_created` is consumed structurally during replay without inspecting its attributes. So an empty initial event log replays identically whether or not the run was seeded with attributes.

That safety is a standing invariant for any future change: if an in-workflow attribute *read* API is ever added, it MUST read from the run snapshot (which turbo populates from the run input) and **not** by replaying `run_created` / `attr_set` events. Reading from the event log would surface seed attributes as empty on the first turbo delivery only, causing a turbo-exclusive divergence from the non-turbo path. `start()` cannot seed hooks or waits, so there is no start-seeded suspension state for the skipped load to miss.

### Configuration

Turbo mode is **on by default**. Set `WORKFLOW_TURBO=0` (or `false`) to disable it. Every invocation then takes the existing awaited path. This is a useful kill-switch for deployments whose first-step bodies are not idempotent and stream-safe (the same caveat as optimistic inline start), or for isolating behavior while debugging.

Turbo forces optimistic inline start on the first invocation regardless of `WORKFLOW_OPTIMISTIC_INLINE_START` (its single-handler guarantee removes the double-execution race that flag guards against). It does, however, **honor an explicit `WORKFLOW_OPTIMISTIC_INLINE_START=0`**: because forced optimistic start still runs the body before `step_started`/`run_started` is confirmed, an operator who has explicitly disabled optimistic start keeps the await-then-run path even under turbo (the rest of turbo, including backgrounded `run_started` and the skipped initial load, still applies). With the flag unset (the default), turbo forces it on.

Turbo mode is purely client-side and builds on the lazy/optimistic inline start support already shipped, so it requires no world or backend changes.

### Considered: running ahead of durable writes (not implemented on spec 8)

Spec 9 runs do run ahead, within bounds that address the two reasons below (see [Run-ahead](/docs/changelog/single-orchestrator#run-ahead) on the single orchestrator page). On spec 8 runs the reasoning stands:

Turbo overlaps the *start* round-trips with a step's body, but it still **awaits each `step_completed` before advancing** to the next step. We explored going further with "run-ahead": within a single invocation, execute the workflow forward across a sequential chain *without* awaiting each step's event writes, draining `step_started`/`step_completed` through a background FIFO queue and only blocking on a full drain before acking. A run of three sub-millisecond steps would then fire all the bodies back-to-back while the six event posts caught up in the background, turning per-step latency into `max(Σ body, Σ post)` instead of `Σ(body + post)`.

We decided **not** to ship it, for two reasons:

1. **Re-execution blast radius on failure.** Awaiting each completion means a crash re-runs essentially one in-flight step. Running ahead leaves many completions undrained at once, so a crash or `maxDuration` SIGTERM re-runs *all* of them on redelivery. This creates a much larger at-least-once blast radius, precisely on the latency-sensitive runs most likely to pack many steps into one invocation.
2. **Divergent branches from non-durable results.** Advancing past a step before its result is durable lets the workflow commit to a forward path that a crash-and-redeliver can re-decide differently. A `Promise.race([B, C])` resolved by local timing can pick `B`, run `D(B)`, then crash before `step_completed_B` is durable. The redelivery may re-resolve to `C`, so `D` executed against a winner the durable history never records. The same shape appears for a branch on a non-deterministic step output (`B(v1)` runs, crash, redelivery commits `B(v2)`). Idempotency doesn't cover these because `D(B)`/`D(C)` and `B(v1)`/`B(v2)` are *different* operations, not retries of one. A "run ahead only while at most one result is undurable" gate would contain the race case (a race needs ≥2 concurrent undurable steps) but not the non-deterministic-output case, and that residual hazard plus the re-execution blast radius outweighed the gain.

So turbo deliberately stops at forced-optimistic *start* and awaits each `step_completed` before moving on: re-execution after a crash stays deterministic (each step re-runs against the same durable inputs) and bounded (roughly one step, not the whole chain). The idea is recorded here in case a future change (e.g. a determinism signal on steps, or deterministic race resolution) makes run-ahead safe enough to revisit.
