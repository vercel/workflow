---
title: Turbo mode (fast first invocation)
description: Fast-path the very first delivery of the first invocation — background run_started, skip the initial event-log load, and force optimistic inline start — so a run blazes through its first steps. A no-op for everything else.
---

# Turbo mode

## Motivation

The first invocation of a workflow run is where time-to-first-step matters most, yet it pays the most fixed network latency before any user code runs. Three round-trips sit on that critical path today:

1. **`run_started` is awaited.** The handler writes `run_started` and waits for it to return the run entity before doing anything else.
2. **The event log is loaded.** A full `events.list` runs before the first replay — even though on the very first delivery nothing has written any events yet.
3. **Optimistic inline start is off by default.** The [optimistic inline start](./lazy-event-creation#optimistic-inline-start-opt-in-off-by-default) optimization (running a step body before its `step_started` is confirmed) is off by default because under contention two handlers can both run a body and corrupt non-idempotent side effects.

Turbo mode removes all three costs **for the first delivery of the first invocation only**, where each is provably safe to remove, then gets out of the way. For every subsequent invocation it is a complete no-op.

## What turbo mode does

When the handler detects the first delivery of the first invocation, it:

1. **Backgrounds `run_started`.** The event is written without awaiting; the run entity is synthesized locally from the queued run input (status `running`, `startedAt` now) so replay can begin immediately. The `run_started` round-trip overlaps replay instead of blocking it. This reuses the [resilient start](./resilient-start) contract — `run_started` carrying the run input creates the run on the fly (synthetic `run_created`) if it doesn't exist yet.
2. **Skips the initial event-log load.** Nothing has been written, so the first replay runs against an empty log. The second loop iteration does a normal incremental load once the first step's events exist.
3. **Forces optimistic inline start** for that invocation, independent of `WORKFLOW_OPTIMISTIC_INLINE_START`. The step body runs immediately against locally-synthesized state; only the `step_started` network write waits for the backgrounded `run_started`.

The net effect: the first step body starts after just the in-process replay, with `run_started` and `step_started` happening in the background around it, and no `events.list` before it.

## Why this is safe (and where it stops)

### Detection

The first-invocation message is the only one that carries the queued **run input**, and the queue delivery **attempt is 1** (a redelivery is attempt ≥ 2). Together with "not a background-step invocation" and "not a divergence recovery", that uniquely identifies the first delivery of the first invocation — with no new message field and no world/backend change.

### The single-handler guarantee

Forcing optimistic start is unsafe *in general* because two handlers racing the same step's create-claim can both run the body before one wins. On the first delivery of the first invocation there is **no concurrent peer handler** — the run was created moments ago by `start()` and only this one message is in flight. So the body runs exactly once, and forcing optimistic start is safe here even though the global flag is off.

### Turbo exits on the first hook or wait

That single-handler guarantee ends the moment the run creates a **hook** or **wait** (or writes attributes): those introduce later resume/parallel invocations that *can* race. So turbo stops forcing optimistic start as soon as a suspension creates any of them — the inline steps of that suspension fall back to the normal await-then-run path, and the rest of the run behaves exactly as it does today. A pure-step suspension (the common hot path) stays on the fast path.

### Write ordering is preserved

Because `run_started` is backgrounded, every event write is gated on a run-ready barrier so nothing is written before the run exists:

- The optimistic `step_started` is **chained** on the barrier — the body still runs immediately, only the network write waits.
- The suspension handler **awaits** the barrier before any eager write (`hook_created`, `wait_created`, overflow `step_created`). The pure inline hot path defers all its steps and writes nothing here, so it never blocks on the barrier.
- Terminal run writes (`run_completed` / `run_failed`) await the barrier too, so a workflow that finishes with no steps still orders its completion after `run_started`.

The event log therefore still reads `run_created → run_started → step_created → step_started → step_completed`. If the backgrounded `run_started` genuinely fails (e.g. the run was cancelled in the meantime), the chained writes surface the real error (`gone` / run-not-found) and the message redelivers as a normal, non-turbo attempt.

The barrier orders **event** writes. The forced-optimistic first step **body** runs immediately, so any side effects it performs *before* the terminal write — stream writes via `getWritable()` and the per-step ops flush — are **not** gated on the barrier and can reach the world before the backgrounded `run_started` lands (and are orphaned if it ultimately fails). This is the same exposure as optimistic inline start and is covered by the stream-safety caveat below; deployments whose first step writes to the workflow stream and require strict `run_created → run_started` ordering of stream data should set `WORKFLOW_TURBO=0`.

### A run cancelled before its first delivery still runs the first step body

The non-turbo path awaits `run_started` up front and, if the run was cancelled or expired between `start()` and this delivery, returns before any workflow/step code runs. Turbo synthesizes `status: 'running'` and runs the first step body optimistically, so such a cancellation is only observed when the backgrounded `run_started` (and the barrier-chained `step_started`) rejects — *after* the body's side effects have executed (they are then discarded via reconciliation). For non-idempotent first steps this is the same "body runs before ownership is confirmed" tradeoff as optimistic inline start; `WORKFLOW_TURBO=0` restores the up-front skip.

### `workflowStartedAt` reflects the first delivery's clock

Replay matching — step/wait/hook correlation IDs, the VM seed, and the in-VM `Date.now()` — is derived from a replay-stable timestamp recovered from the run ID, so it does **not** depend on `startedAt` and is identical on every delivery. The one value that still tracks `startedAt` is the user-facing `getWorkflowMetadata().workflowStartedAt`: under turbo the first delivery synthesizes it from the local clock, while a later (non-turbo) delivery loads the server-canonical `startedAt`, so the two can differ by the start→first-delivery latency. Treat `workflowStartedAt` as an approximate, human-facing timestamp — do **not** branch workflow control flow on it (e.g. `Date.now() - +workflowStartedAt > threshold`), since that can take different paths across deliveries and diverge on replay. For timing logic that must survive replay, use the in-VM `Date.now()` / `new Date()`, which is replay-stable.

### Attributes seeded at `start()` survive the skipped event load

`start({ attributes })` does **not** disable turbo, and it needs no synthetic event in the empty log. Seed attributes are folded into the `run_created` event's data (not separate `attr_set` events) and ride along in the queued run input, so the locally-synthesized run snapshot carries them — turbo skipping the initial `events.list` loses nothing.

This is safe specifically because **attributes are write-only inside a workflow**: there is no in-workflow read API today, and `run_created` is consumed structurally during replay without inspecting its attributes. So an empty initial event log replays identically whether or not the run was seeded with attributes.

That safety is a standing invariant for any future change: if an in-workflow attribute *read* API is ever added, it MUST read from the run snapshot (which turbo populates from the run input) and **not** by replaying `run_created` / `attr_set` events. Reading from the event log would surface seed attributes as empty on the first turbo delivery only — a turbo-exclusive divergence from the non-turbo path. `start()` cannot seed hooks or waits, so there is no start-seeded suspension state for the skipped load to miss.

## Configuration

Turbo mode is **on by default**. Set `WORKFLOW_TURBO=0` (or `false`) to disable it — every invocation then takes the existing awaited path. This is a useful kill-switch for deployments whose first-step bodies are not idempotent and stream-safe (the same caveat as optimistic inline start), or for isolating behavior while debugging.

Turbo forces optimistic inline start on the first invocation regardless of `WORKFLOW_OPTIMISTIC_INLINE_START` (its single-handler guarantee removes the double-execution race that flag guards against). It does, however, **honor an explicit `WORKFLOW_OPTIMISTIC_INLINE_START=0`**: because forced optimistic start still runs the body before `step_started`/`run_started` is confirmed, an operator who has explicitly disabled optimistic start keeps the await-then-run path even under turbo (the rest of turbo — backgrounded `run_started`, skipped initial load — still applies). With the flag unset (the default), turbo forces it on.

Turbo mode is purely client-side and builds on the lazy/optimistic inline start support already shipped — it requires no world or backend changes.

## Considered: running ahead of durable writes (not implemented)

Turbo overlaps the *start* round-trips with a step's body, but it still **awaits each `step_completed` before advancing** to the next step. We explored going further — "run-ahead": within a single invocation, execute the workflow forward across a sequential chain *without* awaiting each step's event writes, draining `step_started`/`step_completed` through a background FIFO queue and only blocking on a full drain before acking. A run of three sub-millisecond steps would then fire all the bodies back-to-back while the six event posts caught up in the background, turning per-step latency into `max(Σ body, Σ post)` instead of `Σ(body + post)`.

We decided **not** to ship it, for two reasons:

1. **Re-execution blast radius on failure.** Awaiting each completion means a crash re-runs essentially one in-flight step. Running ahead leaves many completions undrained at once, so a crash or `maxDuration` SIGTERM re-runs *all* of them on redelivery — a much larger at-least-once blast radius, precisely on the latency-sensitive runs most likely to pack many steps into one invocation.
2. **Divergent branches from non-durable results.** Advancing past a step before its result is durable lets the workflow commit to a forward path that a crash-and-redeliver can re-decide differently. A `Promise.race([B, C])` resolved by local timing can pick `B`, run `D(B)`, then crash before `step_completed_B` is durable — and the redelivery may re-resolve to `C`, so `D` executed against a winner the durable history never records. The same shape appears for a branch on a non-deterministic step output (`B(v1)` runs, crash, redelivery commits `B(v2)`). Idempotency doesn't cover these — `D(B)`/`D(C)` and `B(v1)`/`B(v2)` are *different* operations, not retries of one. A "run ahead only while at most one result is undurable" gate would contain the race case (a race needs ≥2 concurrent undurable steps) but not the non-deterministic-output case, and that residual hazard plus the re-execution blast radius outweighed the gain.

So turbo deliberately stops at forced-optimistic *start* and awaits each `step_completed` before moving on: re-execution after a crash stays deterministic (each step re-runs against the same durable inputs) and bounded (roughly one step, not the whole chain). The idea is recorded here in case a future change (e.g. a determinism signal on steps, or deterministic race resolution) makes run-ahead safe enough to revisit.
