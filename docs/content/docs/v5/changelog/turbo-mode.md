---
title: Turbo mode (fast first invocation)
description: Fast-path the first delivery of a run by backgrounding run_started, skipping the initial event-log load, and starting the first inline steps before their start commits. A no-op for everything else.
---

# Turbo mode

Turbo mode applies to runs on the [single orchestrator](/docs/changelog/single-orchestrator) model (spec version 9). It changes only the first delivery of a run's first orchestrator message; every other delivery takes the normal path.

## Motivation

The first invocation of a workflow run is where time-to-first-step matters most, yet it pays the most fixed network latency before any user code runs. Without turbo, these round-trips sit in front of the first step body:

1. **The event log is loaded**, together with the in-band fence count, and the run is read, before anything is written.
2. **`run_started` is awaited**, and the log is loaded again to pick it up.
3. **The first step's `step_created` and `step_started` are awaited** before its body runs.

On the first delivery none of them can change what the orchestrator decides: the log holds only `run_created`, the fence count after the run's creation is known, and no other orchestrator of the run can exist yet. Turbo mode removes all three for that delivery only.

## What turbo mode does

When the handler detects the first delivery of the first message, it:

1. **Backgrounds `run_started`.** The event goes out without waiting, through the delivery's in-band writer, and the run is synthesized locally from the queued run input (status `running`, `startedAt` now), so replay begins immediately. This reuses the [resilient start](./resilient-start) contract: a `run_started` carrying the run input creates the run when `run_created` never landed. Because turbo uses this `run_started` as a write barrier and never reads its response's log page, it asks the World to **skip the `run_started` event-log preload**. A World that ignores the hint stays correct.
2. **Skips the initial event-log load.** The first replay runs against an empty log. The in-band writer starts from the fence count right after the run's creation (`run_created` counts as the run's first in-band position), which is the count a load would have returned. The responses of the delivery's own writes, `run_started` included, fold their events and skipped-slot reports into the log, so the next pass usually needs no load either.
3. **Starts inline step bodies before their start commits** (optimistic inline start). The first step's `step_created` and `step_started` go out in one batch write behind `run_started`, and the body runs while they are in flight. Its outcome is written only after its start committed.

The first step body starts after the in-process replay, with `run_started`, `step_created` and `step_started` written in the background around it and no `events.list` before it.

## Why this is safe (and where it stops)

### Detection

The first message is the only one that carries the queued **run input**. Turbo engages when it does, its delivery count is 1 (a redelivery, including the one after a fence refusal, counts higher), and the delivery is not a background step, a divergence recovery, a hook resume or a timer.

### One orchestrator, one writer

Starting a body before its start commits is unsafe in general: if the in-band fence then refuses the start because another orchestrator invocation of the run holds it, the body ran without a durable record and runs again. On the first delivery of the first message there is no other orchestrator yet: the run was created moments ago by `start()`, and this one message is the only one in flight. The body therefore runs once.

### Turbo stops on the first hook or wait

A hook or a wait gives the run writers other than this delivery (a hook resume, a timer, `wakeUp()`), each of which wakes the orchestrator. Turbo stops starting bodies ahead of their start for the rest of the delivery as soon as a suspension has a hook or a wait. Later inline steps of that delivery wait for their start to commit, as on every other delivery. Attribute writes resolve in this process and do not end it.

### Every write still lands after `run_started`

- Every in-band write of the delivery goes through one in-band writer, which serializes them. `run_started` is the first, so `step_created`, `step_started`, `wait_created`, hook events and the run's terminal event all queue behind it. The log still reads `run_created → run_started → step_created → step_started → step_completed`.
- Writes made outside the in-band writer by an optimistic step body wait on the run-ready barrier: stream writes through `getWritable()`, a writable stream passed as a step argument, a stream the step returns, and `setAttributes()`.
- An awaited start (with `WORKFLOW_OPTIMISTIC_INLINE_START=0`) also waits for `run_started` before it is sent.

### When `run_started` or a later write is refused

If the backgrounded `run_started` fails for any reason, a definite refusal included, the in-band writer stops: nothing else this delivery would write reaches the World, and no further inline body starts. Bodies that already started settle first, their outcomes are discarded, and the delivery ends as an awaited `run_started` failing the same way would end it:

- refused by the in-band fence (`InBandSupersededError`): not acknowledged, redelivered after the fence delay, and the redelivery loads the log;
- the run already finished (for example cancelled before its first delivery): acknowledged with nothing written;
- anything else: retried by the queue, or recorded as a setup failure.

Stream and attribute writes waiting on the barrier fail instead of writing, so a refused start leaves no chunks or attributes on a run whose log does not record the step that made them. A body that ran before such a refusal does run again on the redelivery.

The same holds for the step's own start: if its batch is refused, the body's outcome is not written, and the start's error decides (a throttle defers the run, a finished run ends the delivery, anything else fails it).

### A run cancelled before its first delivery still runs the first step body

The normal path loads the run up front and returns before any workflow or step code runs if the run was cancelled or expired between `start()` and this delivery. Turbo synthesizes `status: 'running'` and runs the first step body before `run_started` returns, so the cancellation is only observed when `run_started` is refused, after the body's side effects ran. `WORKFLOW_TURBO=0` restores the up-front check.

### `workflowStartedAt` reflects the first delivery's clock

Replay matching (step, wait and hook correlation IDs, the VM seed, and the in-VM `Date.now()`) is derived from a replay-stable timestamp recovered from the run ID, so it does **not** depend on `startedAt` and is identical on every delivery. The one value that still tracks `startedAt` is the user-facing `getWorkflowMetadata().workflowStartedAt`: under turbo the first delivery synthesizes it from the local clock, while a later delivery reads the World's `startedAt`, so the two can differ by the start-to-first-delivery latency. Treat `workflowStartedAt` as an approximate, human-facing timestamp, and do not branch workflow control flow on it. For timing logic that must survive replay, use the in-VM `Date.now()` / `new Date()`.

### Attributes seeded at `start()` survive the skipped event load

`start({ attributes })` does **not** disable turbo. Seed attributes are folded into the `run_created` event's data and ride along in the queued run input, so the synthesized run carries them. This is safe because **attributes are write-only inside a workflow**: there is no in-workflow read API, and `run_created` is consumed structurally during replay. If an in-workflow attribute *read* API is ever added, it MUST read from the run snapshot (which turbo populates from the run input), not by replaying `run_created` / `attr_set` events, or it would see no seed attributes on the first turbo delivery only.

## Configuration

Turbo mode is **on by default**. Set `WORKFLOW_TURBO=0` (or `false`) to disable it: every delivery then loads the log, awaits `run_started`, and waits for each inline step's start to commit before its body runs. Use it for deployments whose first-step bodies are not idempotent, or to isolate behavior while debugging.

`WORKFLOW_OPTIMISTIC_INLINE_START=0` (or `false`) keeps turbo's backgrounded `run_started` and skipped initial load, and makes the first delivery's inline bodies wait for their start to commit. No other value of it does anything: on single-orchestrator runs there is no optimistic inline start outside turbo's first delivery, because only that delivery is known to have no other orchestrator.

Turbo mode is client-side and needs no World changes. A World with `createBatch` saves the separate `step_started` write; one without it gets the start as its own write, chained behind `step_created`.

## Considered: running ahead of durable writes (not implemented)

Turbo overlaps the *start* round-trips with a step's body, but it still **awaits each `step_completed` before advancing** to the next step. We explored going further with "run-ahead": within a single invocation, execute the workflow forward across a sequential chain *without* awaiting each step's event writes, draining `step_started`/`step_completed` through a background FIFO queue and only blocking on a full drain before acking. A run of three sub-millisecond steps would then fire all the bodies back-to-back while the six event posts caught up in the background, turning per-step latency into `max(Σ body, Σ post)` instead of `Σ(body + post)`.

We decided **not** to ship it, for two reasons:

1. **Re-execution blast radius on failure.** Awaiting each completion means a crash re-runs essentially one in-flight step. Running ahead leaves many completions undrained at once, so a crash or `maxDuration` SIGTERM re-runs *all* of them on redelivery. This creates a much larger at-least-once blast radius, precisely on the latency-sensitive runs most likely to pack many steps into one invocation.
2. **Divergent branches from non-durable results.** Advancing past a step before its result is durable lets the workflow commit to a forward path that a crash-and-redeliver can re-decide differently. A `Promise.race([B, C])` resolved by local timing can pick `B`, run `D(B)`, then crash before `step_completed_B` is durable. The redelivery may re-resolve to `C`, so `D` executed against a winner the durable history never records. The same shape appears for a branch on a non-deterministic step output (`B(v1)` runs, crash, redelivery commits `B(v2)`). Idempotency doesn't cover these because `D(B)`/`D(C)` and `B(v1)`/`B(v2)` are *different* operations, not retries of one. A "run ahead only while at most one result is undurable" gate would contain the race case (a race needs ≥2 concurrent undurable steps) but not the non-deterministic-output case, and that residual hazard plus the re-execution blast radius outweighed the gain.

So turbo deliberately stops at forced-optimistic *start* and awaits each `step_completed` before moving on: re-execution after a crash stays deterministic (each step re-runs against the same durable inputs) and bounded (roughly one step, not the whole chain). The idea is recorded here in case a future change (e.g. a determinism signal on steps, or deterministic race resolution) makes run-ahead safe enough to revisit.
