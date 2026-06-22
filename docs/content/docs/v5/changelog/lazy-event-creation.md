---
title: Lazy inline step start
description: Defer step_created for the inline step and fold it into a single step_started, saving one world round-trip per inline step.
---

# Lazy inline step start

## Motivation

The owned-inline runtime path used to write two separate world events for a step it already owns and is about to run inline:

1. `step_created` — written by the suspension handler (`suspension-handler.ts`)
2. `step_started` — written by `executeStep` (`step-executor.ts`)
3. `step_completed` / `step_failed` — written by `executeStep`

On the Vercel world each `world.events.create` is a network round-trip, so for a simple sequential `"use step"` workflow this is pure latency between steps. Steps (1) and (2) are two round-trips for a step we already own and are about to execute in the same invocation.

This change defers `step_created` for that one inline step: `executeStep` sends a single `step_started` carrying the step input, and the world creates the step on the fly — materializing the step entity **and** a synthetic `step_created` event so replay still observes it. **Two writes per inline step instead of three.** It mirrors the existing [resilient `run_started` → `run_created`](./resilient-start) pattern.

Steps that are *queued* (not run inline) keep their eager `step_created` and are unchanged. Only the single inline step per suspension is made lazy.

## Design

### Suspension handler

- `handleSuspension` selects exactly one step to defer — the first uncreated step (`stepItems.find(item => stepsNeedingCreation.has(...))`), which matches the inline candidate the caller would have picked.
- For that step it **skips** the `step_created` write and instead returns it as `lazyInlineStep = { correlationId, stepName, dehydratedInput }`. It is **not** added to `createdStepCorrelationIds` — ownership is no longer decided here.
- A `lazyInlineStep` is designated only when there is no `hook.getConflict()` awaiter (`hasAwaitedHookCreation === false`). With an awaiter present nothing runs inline, so nothing is deferred.

### `executeStep`

- A new `lazyStepInput` parameter carries the already-dehydrated input. When present, the `step_started` event includes `input` so the world creates the step on the fly. When absent, `step_started` carries only `stepName` (the legacy contract).
- For an **unregistered** step on the lazy path, `executeStep` sends the lazy `step_started` first to materialize the step, *then* writes `step_failed` (see [Materialize before failing](#materialize-before-failing-unregistered-steps) below).

### World contract

- `step_started` accepts an optional `input`. When provided for a non-existent step, the world creates the step entity plus a **synthetic `step_created`** event (so the event log reads `created → started → completed`), then records `step_started` — atomically.
- A `stepCreated` signal is added to the event result so callers can tell whether the lazy `step_started` created the step or attached to an existing one.
- Worlds updated: `world-local`, `world-postgres`, `world-vercel`.

## Interactions with inline execution

### Exactly-one-owner is preserved (the race moved)

The guarantee that exactly one handler runs a step's body inline is intact — it just resolves at a different event:

- **Before:** ownership was won at the atomic `step_created` claim in the suspension handler; the loser caught `EntityConflictError` and queued instead.
- **After:** two concurrent handlers may both *select* the same `lazyInlineStep` (selection is optimistic, before any race). The race is now the world's atomic create-claim inside the lazy `step_started` (lock file in world-local, `onConflictDoNothing` + unique index in world-postgres, `attribute_not_exists` on the server). The loser gets `EntityConflictError`, which `executeStep` maps to `{ type: 'skipped' }`, so it never runs the body.

This is safe **because a lazy `step_started` is only ever sent for a brand-new step** — the suspension handler defers only steps with no prior `step_created` (`!hasCreatedEvent`).

### Crash recovery is unchanged

On crash recovery the step already has a `step_created` event in the log (`hasCreatedEvent === true`), so it is **not** a lazy candidate. It is re-queued and re-run via a normal **non-lazy** `step_started`, which re-starts a `running` step. At-least-once execution is preserved exactly as before.

### Materialize before failing unregistered steps

The inline path previously assumed an invariant: *by the time `executeStep` runs, the step entity already exists* (the suspension handler created it). The unregistered-step branch relied on this — it writes `step_failed` directly, with no preceding `step_started`.

With the `step_created` deferred, the entity no longer exists when `executeStep` bails for an unregistered step, so the `step_failed` write hits the world's "step must exist" ordering guard and is rejected — wedging the run until it times out. The fix: on the lazy path, send the lazy `step_started` first (creating the entity + synthetic `step_created`), then write `step_failed`. The lazy `step_started`'s atomic create-claim still preserves exactly-one-owner — a concurrent winner makes our create reject with `EntityConflictError` → `skipped`, so the failure is never written twice.

This is the general rule the deferral introduces: **any inline path that writes a terminal step event must first ensure the deferred step has been materialized.**

### Replay correctness and the inline-delta fast path

The client step consumer (`step.ts`) sets `hasCreatedEvent` only when it observes a `step_created` event, and checks step-name divergence against `stepName`. The lazy path stays replay-correct only because the world writes a **synthetic `step_created`**: replay still sees `created → started → completed`. The input lives on the synthetic `step_created`; the `step_started` row drops the input but keeps `stepName` for the divergence check.

This intersects with the inline-delta optimization. The delta returned on the `step_completed` write is consumed by the *next* replay in place of an `events.list`, diffed against `preInlineWriteCursor` (snapshotted before replay). Because the synthetic `step_created`, `step_started`, and `step_completed` are all written *after* that cursor, the world's "events since cursor" delta carries the full triple — so the next replay does not diverge. The delta gate (one step, no hooks/waits, the lone pending step is the inline one) is unchanged.

### Pre-emption by attributes / hook conflicts

When `attr_set` events or a hook conflict force an immediate re-invocation, the handler returns *before* the dispatch loop. The deferred step is therefore **neither created nor queued** on that pass; it is recreated and run on the re-invocation (where it is still a lazy candidate).

This is a small behavioral improvement: previously the eager `step_created` left an orphan "created but never started" event when a step lost an attribute/hook race (e.g. `Promise.race([setAttributes(), step()])` where the attribute write wins and completes the run). With deferral, a step that loses the race is never created at all — less event-log garbage.

### `hook.getConflict()` awaiter

When a `hook.getConflict()` awaiter is present, no `lazyInlineStep` is designated, nothing runs inline, every step gets its eager `step_created` and is queued, and the handler re-invokes immediately so replay resolves the awaiter. This is identical to the pre-change behavior — the deferral never serializes the awaiter's parallel continuation behind an inline step.

## Rollout and compatibility

Server-first. The matching world-vercel backend change must deploy before this ships; the Vercel world targets a single backend whose spec version is always at least the SDK's, so the new SDK only ever talks to an already-upgraded backend. An old SDK against a new backend is safe because the lazy path is strictly additive — it triggers only when `step_started` carries both `stepName` and `input`, which old SDKs never send. For `world-local` / `world-postgres` the world ships in the same package as the runtime, so there is no version skew. Detection is by `input` presence on the event, mirroring resilient `run_started` — no capability negotiation is needed.

# Parallel inline steps + optimistic start

A follow-up builds two more latency wins on top of lazy inline start. Both are client-side only — they reuse the world's lazy create-on-`step_started` support and need no further world/backend changes.

## Inline up to N steps in parallel

Previously the owned-inline path ran **exactly one** step inline per suspension and queued the rest. For a `Promise.all([stepA(), stepB(), stepC()])` fan-out that meant one branch ran inline while the others paid a queue round-trip each before making any progress.

The suspension handler now defers `step_created` for up to **`WORKFLOW_MAX_INLINE_STEPS` (default 3)** steps and returns them as `lazyInlineSteps`. The runtime runs that batch inline **in parallel** (`Promise.all`), each via its own lazy `step_started`, and queues only the steps beyond the cap.

- **Selection:** the first N uncreated steps, matching the previous single-step inline candidate. Steps beyond N keep their eager `step_created` and are queued exactly as before.
- **Result aggregation:** `retry` steps (whose `step_started` succeeded, so the step exists) are re-queued per-step as background steps with their own delay. `throttled` steps are different: a throttle rejects the lazy `step_started` on the create-claim, so the step was *never created* and has no recoverable input — re-queuing it as an input-less background step would make the world reject the bare `step_started` with "Step not found" and redeliver until it fails. So any throttle instead **defers redelivery of the orchestrator** (by the longest throttle backoff in the batch), which re-runs the throttled step inline *with its input* on replay. The runtime only loops back to replay in-process once every inline step has reached a terminal state.
- **Inline-delta fast path:** still used only for the single-step sequential case (`lazyInlineSteps.length === 1`). With more than one inline step each writes its own events, so a per-write delta would be partial; multi-step batches fall back to a normal incremental `events.list`.
- **Config:** `WORKFLOW_MAX_INLINE_STEPS` is clamped to 1..16. Setting it to `1` reproduces the previous single-inline-step behavior exactly (a useful kill-switch). Inline bodies run in parallel within one function invocation, so the cap also bounds per-handler memory/CPU fan-out.

## Optimistic inline start (opt-in, off by default)

Normally `executeStep` awaits `step_started` (the lazy create-claim round-trip) before running the body. Because the inline path already holds the step input locally, it doesn't actually need that round-trip to begin.

When `WORKFLOW_OPTIMISTIC_INLINE_START` is enabled (set it to `1`/`true` — it is **off by default**), an inline step fires `step_started` **without awaiting it** and starts running the body immediately against locally-synthesized state. A lazy step is always brand-new, so attempt is 1, there is no prior error, and `startedAt` is now — all known without the server. The in-flight `step_started` is reconciled just before the terminal write:

- **Lost the create-claim (409 / `EntityConflictError`)** → discard the body result and return `skipped`; the winning handler owns the terminal write.
- **Run gone / throttled / too-early** → discard the body result and surface `gone` / `throttled` / `retry`.
- **Transient (non-translatable) failure** → propagate it, so the queue redelivers — exactly as the await path does today.
- **Success** → write `step_completed` / `step_failed` / `step_retrying` as usual. Awaiting `step_started` before the terminal write keeps the event log ordered (`created → started → completed`).

### Safety and the idempotency tradeoff

- **Exactly-one terminal write is preserved.** Optimistic start changes only *when the body runs*, never who writes the terminal event — that is still gated by the lazy `step_started` create-claim, which is awaited before the terminal write. Losers return `skipped`.
- **Bounded to attempt 1.** Only brand-new (`!hasCreatedEvent`) steps are lazy; a retried step already has a `step_created`, so it takes the normal await-then-run path with the real attempt counter. Synthesizing `attempt = 1` locally is therefore always correct.
- **Wider double-execution — why it's off by default.** Running the body before confirming ownership means two handlers racing for the same step's create-claim can *both* run the side effects before either wins (previously the loser 409'd on `step_created` and skipped before running anything). This is unsafe for non-idempotent steps: in particular, two concurrent runs of a step that writes to the **workflow stream** (e.g. an AI agent streaming tokens) can interleave and **corrupt the stream data**. So the optimization ships **disabled**; enable it (`WORKFLOW_OPTIMISTIC_INLINE_START=1`) only for deployments whose inline step bodies are idempotent and stream-safe.

## Queue messages: inline steps don't pay a round-trip

Inline steps that **complete** never enqueue a per-step flow-route message. When every step in an inline batch reaches a terminal state with no pending background ops, the runtime simply continues its in-process loop and replays — so a sequential chain (or a clean parallel fan-out) of inline steps runs entirely within one invocation with **zero** queue messages. Verified: a workflow whose only work is three parallel inline steps issues no `queue()` calls.

The only flow-route messages produced around an inline batch are:

- **Pre-batch dispatch** — the steps *beyond* the inline cap (and any pending wait/sleep continuation). Inline steps are explicitly excluded from this dispatch.
- **`retry` results** — one delayed message per retried step. A retry *is* the step becoming its own background invocation, so this is expected.
- **`throttled` results** — a single deferral of the orchestrator message (see above).
- **Pending background ops** — if any inline step left unflushed stream writes (e.g. output streams to blob storage), the loop breaks and enqueues **one** continuation (aggregated across the batch, not per-step) so `waitUntil` can flush before the next replay reads them.

In other words: completed inline steps cost no queue round-trips; only steps that genuinely run as their own background invocations create new flow-route messages.
