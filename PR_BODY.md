## Problem

#4457 reports that parallel branches advance in lockstep: a branch whose step finishes cannot create its next step until every sibling in that batch finishes.

```ts
await Promise.all([
  (async () => { await fast1(); await fast2(); await fast3(); })(),
  (async () => { await slow1(); await slow2(); await slow3(); })(),
]);
```

With 200 ms fast steps beside 2 s slow steps, the next fast step starts about 1,809 ms after the prior fast step ends on `main`. With this change the gap is about 87 ms.

## Root cause on `main`

Both hold points are in `workflowEntrypoint()` in `packages/core/src/runtime.ts`:

- The queued-step prologue returns at `Background step done but other steps pending, returning` while any sibling remains pending. Only the last completer replays the workflow.
- The inline loop waits for `Promise.all(stepExecutionPromises)` before replaying, so an early inline completer waits for the slowest step in its batch.

## How this PR works

### Advance-only replay

The queued-step prologue in `workflowEntrypoint()` enters advance-only mode when the feature is enabled, the run uses the Node.js VM, `run_created` is present, and the run stays within `WORKFLOW_ADVANCE_ONLY_REPLAY_MAX_PENDING`. `analyzePendingStepsForReplay()` in `packages/core/src/runtime/branch-replay.ts` derives the pending set, attempt width, run-wide peak, and terminal-probe state in one pass.

Once a run exposes a wider fan-out, step dispatches carry `advanceOnlyEligible: false` into later chained rounds. This prevents an 8-wide chain from splitting into smaller eligible batches as it drains. Older consumers ignore the optional field, and newer consumers derive eligibility from the event log when older producers omit it. `WORKFLOW_ADVANCE_ONLY_REPLAY=0` disables the path and does not publish the hint.

### What a pass owns and the idle exit

`suspensionHasNewWork()`, `advanceOnlyHasWork()`, and `advanceOnlyLeavesStep()` in `packages/core/src/runtime/branch-replay.ts` restrict the pass to work discovered by that replay. The dispatch table sends steps created by this pass and skips pre-existing pending siblings and their backstops. Owned recovery and created-but-never-started recovery on redelivery remain exceptions.

Before `handleSuspension()` runs, `workflowEntrypoint()` calls `advanceOnlyHasWork()`. A pass that found no new work and owes no recovery exits without event writes, entity writes, or queue sends.

### Inline hand-off

Both steps in a two-step batch remain inline as on `main`. When one eligible inline step settles while another is running, `workflowEntrypoint()` waits for every `executeStep()` claim callback, batch dispatches, deferred writes, and `runReadyBarrier`. After the named 10 ms coalescing window, it sends a deduplicated `advanceOnly` continuation if a sibling is still running. The send is joined before acknowledgement. Invoke-capable Worlds skip the hand-off.

The queue hop supplies an isolated invocation and durable ownership boundary. An in-process replay would share replay/session state and correlation-ID sequencing with the retained workflow VM.

### Retrying steps and nested parallel work

When an inline step returns `retry`, `workflowEntrypoint()` publishes its delayed retry immediately with the existing `stepDispatchIdempotencyKey()` rather than waiting for the slowest inline sibling. The end-of-batch path retries a failed publication. If the retry completes while the original batch still owns a sibling, the original invocation reloads storage before continuing instead of trusting its stale in-memory retry result.

The same advance-only path handles parallel tool calls nested inside one branch, such as model → `Promise.all([tool1, tool2])` → model beside a slow agent.

### Terminal behavior

`pendingStepIdsIn()` treats started or scheduled work without a terminal step event as pending. At workflow completion or failure, `drainPendingQueueItems()` reports the IDs left un-awaited by that replay. Creation-only drain rows do not keep the run open, but a step that started before terminal replay does.

Both inline and queued advance-only paths guard `run_completed` and `run_failed`. The advance-only replay that first defers terminal state may publish one safety probe under a per-run idempotency key, delayed by `WORKFLOW_INLINE_OWNERSHIP_LEASE_SECONDS`. The probe does not poll or re-arm while live work remains.

This is derived from replay; no new event field must be persisted by a World.

### Run-row reconstruction and single-flight

`runRowFromCreation()` in `packages/core/src/runtime/branch-replay.ts` reconstructs an early replay's run row from the queue message, `run_created`, and persisted `run_started.createdAt`, avoiding `runs.get()` on each eligible settlement. Missing data falls back to `runs.get()`.

In `runStepSingleFlight()` in `packages/core/src/runtime/step-single-flight.ts`, a waiter runs its own claim attempt when the winner returned `skipped`. A skipped winner ran no body and owns no retry, so propagating that result to every waiter could strand the step. The helper is also used by the QuickJS entrypoint, although advance-only replay itself remains Node-only.

## Safety

| Race or failure | Resolution | Deterministic coverage |
| --- | --- | --- |
| Two early queued replays | Guarded creation and claim fencing converge; stale losers reload storage. | `converges when two queued branches replay early together` |
| Early replay vs. last completer | Conditional writes and single-flight converge on one body and fresh storage. | `converges when an early replay overlaps the last sibling completer` |
| Hand-off vs. batch replay | The hand-off is deduped per run and settled step; guarded writes converge. | `converges when a hand-off overlaps the batch's own replay` |
| Single-flight winner skips | A waiter performs its own claim. | Skipped-winner and multi-loser tests |
| Early replay vs. terminal success/failure | Started or scheduled work delays terminal state; replay-derived drain-only rows do not. | Detached-step gates, dropped-field simulations, queued success/failure guards, and terminal-drain tests |
| Safety probe vs. live executor | One lease-delayed probe is sent and never re-arms. | Long and retrying loser send-count tests |
| Early retry publication races replay | Every publisher uses the same step dispatch key; the original batch reloads after an early retry. | Retry-before-sibling, send-failure fallback, and concurrent no-duplicate tests |
| Wide chained fan-out drains into smaller batches | A conservative queue hint preserves the run-wide ineligibility decision. | Chained-round propagation test and 8×4 benchmark |

An early replay or optional hand-off failure falls back to the ordinary last-completer replay. Cancellation, retries, restarts, hooks, and waits do not depend on the early path.

## Cost and scope

- A productive early settlement adds one deduplicated queue send, one receiving invocation, one event-log read, and one workflow replay. It writes and sends only work found by that replay.
- An idle pass performs the read and replay but no writes or further sends.
- Under load, near-simultaneous eligible leaf steps can cross the 10 ms coalescing window and send an idle hand-off.
- The run-wide eligibility hint keeps wide chained runs on the ordinary path without repeatedly re-deriving the decision. Worlds should preserve complete queue payloads; dropping the optional hint remains correct but adds the fallback event-log analysis.
- A terminal deferral adds at most one lease-delayed safety-probe send from its owning advance-only replay.

At the default limit of 3, three- and four-step leaf batches had median hand-off counts of 2 and median idle-exit counts of 1 and 2. Five- and eight-step leaves and the 8×4 control sent no hand-offs and recorded no idle exits. Raising the limit to 4 admitted the five-step leaf case, which sent 2 hand-offs and recorded 3 idle exits.

## Measurements

World-local through `workbench/vitest`; medians with ranges across 12 runs after warm-up:

| Case | `main` | Fix off | Fix on |
| --- | ---: | ---: | ---: |
| Two no-op steps, workflow wall time | 71 ms (68–74) | 73.5 ms (69–80) | 73 ms (68–80) |
| Two 200 ms steps, workflow wall time | 269 ms (267–272) | 275 ms (270–290) | 269.5 ms (266–273) |
| Two-chain next-step gap | 1,808.5 ms (1,807–1,811) | 1,809 ms (1,808–1,810) | 86.5 ms (80–93) |
| Race winner to next step | 1,808.5 ms (1,807–1,810) | 1,808.5 ms (1,807–1,810) | 80.5 ms (76–84) |
| 100 ms beside 300 / 600 / 1,500 ms, next-step gap | 208 / 507.5 / 1,408 ms | 208 / 507.5 / 1,408 ms | 81 / 80 / 79 ms |

Final fan-out matrix, median and range of 5 clean runs after warm-up:

| Case | Kill switch | Limit 1 | Limit 3 (default) | Limit 4 |
| --- | ---: | ---: | ---: | ---: |
| 3 chained agents, next-step gap | 1,315 ms (1,315–1,318) | 1,315 ms (1,313–1,322) | 116 ms (113–166) | 120 ms (112–152) |
| 4 chained agents, next-step gap | 1,318 ms (1,315–1,324) | 1,329 ms (1,321–1,339) | 112 ms (105–121) | 132 ms (117–184) |
| 3 one-step branches, wall time | 195 ms (171–260) | 184 ms (169–257) | 316 ms (251–388) | 326 ms (253–408) |
| 4 one-step branches, wall time | 287 ms (276–320) | 278 ms (270–287) | 417 ms (402–429) | 453 ms (419–500) |
| 5 one-step branches, wall time | 297 ms (288–310) | 284 ms (281–302) | 282 ms (277–287) | 536 ms (504–544) |
| 8 one-step branches, wall time | 310 ms (305–314) | 302 ms (299–309) | 306 ms (294–318) | 329 ms (299–386) |
| 8 branches × 4 steps, wall time | 706 ms (684–721) | 799 ms (749–906) | 753 ms (750–793) | 788 ms (739–844) |

Limit 3 is the smallest value that advances both three- and four-agent chains. Limit 4 did not improve their continuation gap, admitted more idle leaf work, and did not improve 8×4.

## Configuration

| Variable | Default | Behavior |
| --- | --- | --- |
| `WORKFLOW_ADVANCE_ONLY_REPLAY` | enabled | `0` or `false` restores prior lockstep and hot-path behavior. |
| `WORKFLOW_ADVANCE_ONLY_REPLAY_MAX_PENDING` | `3` | Maximum other steps a run may expose at once and remain eligible. Invalid values warn once and fall back to 3; 0 leaves advancement to the last-completer replay. |

## Comparison with #4965

The PRs share the same basic mechanism and much of the implementation: an optional advance-only payload, an idle exit, existing-sibling skip, owned-recovery and never-started-redelivery exceptions, Node-only/invoke-capable exclusions, row reconstruction, inline hand-off, and the skipped-winner single-flight repair.

| Area | This PR (#4972) | #4965 |
| --- | --- | --- |
| Kill switch | `WORKFLOW_ADVANCE_ONLY_REPLAY` | `WORKFLOW_EAGER_BRANCH_REPLAY` |
| Pending default | `3` | `8` |
| Wide-run behavior | A run-wide peak and optional queue hint keep later chained rounds outside the bound. | Current pending count plus peer/grace checks can admit a draining tail. |
| Pacing | Fixed 10 ms post-durability coalescing window. | Configurable 250 ms pre-replay delay. |
| Hand-off durability | Waits for run readiness, dispatches, deferred writes, and every claim callback. | Nearly identical, but does not wait for `runReadyBarrier`. |
| Hand-off dedupe | Per run and settled step. | No explicit hand-off idempotency key. |
| Terminal pending work | Guards success and failure with replay-derived executable work and a one-shot lease-delayed probe. | No equivalent terminal guard or probe. |

## Not covered

- Runs that expose five or more parallel steps stay on the ordinary path at the default. Raise `WORKFLOW_ADVANCE_ONLY_REPLAY_MAX_PENDING` before the run starts to opt them in.
- Advance-only replay under QuickJS. The shared single-flight repair does run under QuickJS.

## Verification

- Focused core suites: 131 tests passed.
- World queue payload suite: 60 tests passed.
- Workbench advance-only suite on world-local: 28 passed, 1 benchmark-only test skipped.
- Workbench advance-only suite on world-postgres: 28 passed, 1 benchmark-only test skipped.
- Sim World: 42/42 with no consistency violations.

Closes #4457
