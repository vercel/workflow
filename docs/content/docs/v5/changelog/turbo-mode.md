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

## Configuration

Turbo mode is **on by default**. Set `WORKFLOW_TURBO=0` (or `false`) to disable it — every invocation then takes the existing awaited path. This is a useful kill-switch for deployments whose first-step bodies are not idempotent and stream-safe (the same caveat as optimistic inline start), or for isolating behavior while debugging.

Turbo mode is purely client-side and builds on the lazy/optimistic inline start support already shipped — it requires no world or backend changes.
