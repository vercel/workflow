# sim-world workbench

Worked examples for `@workflow/world-sim`: workflows written to make ordering
visible, and a book of scenarios that pin down exactly when external input
arrives.

```bash
pnpm sim                             # play every scenario, print every event stream
pnpm sim hook                        # only scenarios whose id or name contains "hook"
pnpm sim in-flight-after-decision    # one scenario, by id
```

Exits non-zero if any scenario misses an expectation or trips a consistency
check, so it doubles as the package's integration test.

This README is about **adding a scenario**. How the simulator underneath works,
and how to change it, is [`packages/world-sim/README.md`](../../packages/world-sim/README.md);
the internals reference is [`DESIGN.md`](../../packages/world-sim/DESIGN.md).

## Adding a scenario

One scenario, one file in [`scenarios/`](./scenarios), named after its id.
Copy the file next door and change what differs — that is the whole workflow,
and the book is split this way so that it is.

```ts
// scenarios/hook-at-step-started.ts
import type { ScenarioSpec } from '@workflow/world-sim';

export const scenario: ScenarioSpec = {
  id: 'hook-at-step-started',
  name: 'hook arrives inside the step_started commit',
  description: 'The hook payload is written after step_started is durable …',
  workflow: 'approvalWorkflow',
  input: ['doc-1'],
  script: async (sim) => {
    const wf = sim.writer.orchestrator();
    await wf.runToEventCommitted('step_started', 'reserveInventory');
    await sim.deliverHook('approval:doc-1', { approved: true, reviewer: 'ada' });
    await wf.release();
  },
  expect: {
    status: 'completed',
    output: { status: 'settled:reserved:doc-1', reviewer: 'ada' },
  },
};
```

Then import it in [`scenarios/index.ts`](./scenarios/index.ts) and place it in
the `scenarios` array. Order is the only thing that file decides: simplest
first, and each pair of near-identical scenarios adjacent, so a reader meets a
distinction right after the thing it is a distinction from. Put yours next to
the one it is a variation of.

The id is stable and hyphenated; it is what a commit message or a bug report
cites and what the command-line filter matches first. The `name` beside it is
prose and free to be reworded.

The workflow named by `workflow` must be exported from
[`workflows/index.ts`](./workflows/index.ts) — all of them live in that one
file because a scenario is read together with the branch it steers. Prefer
reusing one; a new workflow is only worth it when the shape you need to steer
does not exist yet.

### The three moves

Every script is the same shape: **hold a writer at a named point, act while it
is held, let it go.**

```ts
const wf = sim.writer.orchestrator();
await wf.runToEventCommitted('step_started', 'reserveInventory');
await sim.deliverHook('approval:doc-1', { approved: true });
await wf.release();
```

Because the writer is held *inside* the world call, everything the middle move
does lands in the log before that writer is resumed. That is the entire point
of the writer API: the interleaving is stated, not raced for.

### Which writer commits which event

Naming the wrong writer is a wait that times out, not a silent mismatch — so
the failure is loud, but knowing the rule saves the trip:

| you want to stop at | writer |
| --- | --- |
| `step_started`, `wait_created`, `hook_created`, the run's own decisions | `sim.writer.orchestrator()` |
| `step_completed` / `step_failed` for a step | `sim.writer.step('reserveInventory')` — the step body commits its own outcome |
| whichever step body gets there first | `sim.writer.anyStep()` |

Two steps sharing a function name share a writer id. The three `runTo*`
movements differ in *where* in the call they stop, and the difference between
the first two is the whole reason both exist:

- `runToEventProduced` — the event has crossed the world boundary and has not
  been assigned a position in the event log, so a write that commits during the
  hold sorts *ahead* of it.
- `runToPositionMinted` — it has a position and nothing can read it, so a write
  that commits during the hold sorts *behind* it. That is the hole the guards
  exist to catch.
- `runToEventCommitted` — the event is committed to storage, the writer has not
  resumed.

[API reference](#api-reference) has the full list, including the movements that
are not on a writer at all.

### Two rules, both learned the hard way

- **`runTo` is level-triggered.** A point that has already gone by is an error,
  not a wait. When two writers must be stopped at once, start both waits before
  awaiting either.
- **Arm B's wait before releasing A.** A released writer can reach the next
  point within the same turn, and a wait armed afterwards has missed it.

### Acting while a writer is held

| | |
| --- | --- |
| `sim.deliverHook(token, payload)` | an out-of-band `resumeHook()`: commit `hook_received`, enqueue the flow message |
| `sim.beginHookDelivery(...)` | the same delivery, withheld between its two halves. See [Withholdings](#withholdings) |
| `sim.cancelRun(reason?)` | cancel, as an operator would |
| `sim.advanceTime(ms)` | jump virtual time forward |
| `sim.withholdNextEvent(reads?)` | hide the next committed event from the next `reads` reads. See [Withholdings](#withholdings) |
| `sim.world` | a read-only view of the world at this instant |
| `sim.note(message)` | a free-text marker in the trace |
| `sim.check(name, condition)` | a named assertion in the trace; false fails the scenario |

### What to assert, and what not to

Two different instruments, for two different things:

- **`sim.check`** asserts a *sentence about the middle of the run* — "the live
  pass decided the fork without the hook". It is the only way to pin down a
  fact that exists at one instant and is gone by the end.
- **`expect`** asserts the run's outcome: `status`, and `output` when the
  output is the point.

And one rule that matters more than either: **do not restate an expectation per
world.** A scenario is one sequence of movements; the only thing a flag like
`--append-only` changes is what a read returns. An expectation that has to be
written twice is pinning a *consequence of the reads* rather than a property of
the run, and a scenario that branches its tempo on `sim.appendOnlyLog` is two
scenarios wearing one id.

What catches the fault in every world is the invariant the runner checks for
free: **a run's log must replay back into that run.** So when a flag decides
which branch a run takes, report the branch with `sim.note` and assert only
what holds either way — usually `status`, plus the replay check you get without
asking. Reading `sim.appendOnlyLog` to *phrase* a check's sentence correctly is
fine and encouraged; reading it to choose a different tempo is not.

There is deliberately no way to expect a violation. A scenario states the
outcome the run should have reached and stays red until the runtime gets there.

### Per-scenario world flags

`preconditionGuard`, `countGuard` and `appendOnlyLog` on the spec pick the world
this scenario plays in. The usual reason to set one is a **paired scenario**:
the red one and the same tempo with a fix armed, one flag apart, so the diff is
the argument. The command-line flags below override the spec for a whole run.

## API reference

### Writers

A **writer** is one concurrent thread of execution against the world: the thing
that crosses the world boundary, is assigned a position in the event log, and
commits to storage. Several of them writing to one log is the simulation's
entire subject.

| handle | writer id | what it is |
| --- | --- | --- |
| `sim.writer.orchestrator()` | `orchestrator` | The workflow function and the machinery around it — the suspension handler committing `step_created` / `step_started` / `hook_created` / `wait_created`, the run lifecycle writes, and the reads that decide what to do next. One per queue delivery. |
| `sim.writer.step(shortName)` | `step:<shortName>` | One step body, which commits its own `step_completed` / `step_failed`. Several are in flight inside a single delivery. Two steps sharing a function name share the id. |
| `sim.writer.anyStep()` | `step:*` | Whichever step body reaches the movement first. |
| `sim.writer.any()` | `*` | Whichever writer reaches the movement first. |
| — | `external` | The scenario itself, standing in for what a deployment does out of band: a webhook receiver, an operator cancelling a run. It has no handle and takes no movements — see [Withholdings](#withholdings) for the one place inside it a scenario can reach. |

A handle is a *name*, not a live object: `sim.writer.step('slow')` can be taken
before that step exists and resolves against whichever writer turns up under the
name. `sim.writer.seen()` is not a writer but the ids observed so far, in
first-appearance order.

### Movements

A **movement** is an instruction given to a writer to move to a specific place
and pause there — *held*, in the word the API and the trace use. Every other
writer keeps running; the held one resumes on `release()`.

| method | writer | description |
| --- | --- | --- |
| `wf.runToEventProduced(type, opts?)` | any | Hold once the event has crossed the world boundary — fully formed, attributed, in the trace — and before it is assigned a position in the event log. Anything committed to storage during the hold sorts *ahead* of it. |
| `wf.runToPositionMinted(type, opts?)` | any | Hold once the event is assigned a position in the event log and before it is committed to storage. The position is fixed and no reader can see it, so anything committed during the hold sorts *behind* it. |
| `wf.runToEventCommitted(type, opts?)` | any | Hold once the event is committed to storage, before the writer resumes. |
| `wf.runToCall(call, opts?)` | any | The same three places, for a world call that is not `events.create` — `events.list`, `runs.update`, a queue send. `opts.phase` picks which; it defaults to after the call returns. |
| `wf.release()` | the held one | Resume. Idempotent; awaiting it yields the event loop, so the writer has really moved by the time it resolves. |
| `sim.park(match, label?)` | whichever matches | Hold the next call that matches, whoever makes it. Edge-triggered, unlike `runTo`: it waits for the next occurrence instead of erroring on one already gone by. |
| `sim.until(match, label?)` | whichever matches | Wait for a matching call to cross the world boundary, without holding it. |
| `sim.during(match, body)` | whichever matches | `park`, run `body` while it is held, then release. |

`type` is one event type or an array of them. `opts` is a step name as a bare
string, or `{stepName, token, correlationId, where, label, timeoutMs}`.

Not every world assigns a position without also committing it. Under
`--append-only` the position an event holds at `runToPositionMinted` is
provisional — a write overtaken while paused is reassigned to the tail when it
commits — so the gap that movement exists to open is closed by construction.
That is a result the book is there to produce, not a reason to avoid the
movement.

### Withholdings

A **withholding** keeps something out of what a reader can see without holding
the writer that produced it. Where a movement stops one thread, a withholding
lets every thread run and changes what storage answers.

| method | writer | description |
| --- | --- | --- |
| `sim.withholdNextEvent(reads?)` | whichever commits next | Hide the next event committed to storage from the next `reads` event-log reads (default 1). Call it immediately before the write to hide. |
| `sim.beginHookDelivery(token, payload)` | `external` | Deliver a hook, withheld between its two halves: assigned a position in the event log, not committed to storage. Returns `{eventId, commit()}`. |

`beginHookDelivery` is the one place inside an `external` writer a scenario can
reach, and it is a withholding rather than a movement because holding that
writer would be the wrong model: an out-of-band receiver is a separate process
from the run's invocation, so nothing of the run's is blocked while its write is
in flight. Holding an inline write instead would stall the delivery that made
it, and the reader with it.

Both are world-sensitive the same way `runToPositionMinted` is. Under
`--append-only` a withheld read is cut short at the withheld event rather than
missing it from the middle — the log can be behind, never wrong — and a hook
whose position was overtaken re-takes the tail on `commit()`.

## Flags

| flag | effect |
| --- | --- |
| `--verbose` | include queue deliveries in the trace |
| `--color` / `--no-color` | force colour on through a pipe / off. Default: on for a terminal, off otherwise, so `pnpm sim > out.txt` is already diffable |
| `--append-only` / `--no-append-only` | play against an append-only log, or force production behaviour back on |
| `--fence` / `--no-fence` | force the optimistic-concurrency fence on or off for every scenario |
| `--report-only` | print every failure, exit 0 anyway |
| `--summary-file <path>` | one collapsed `<details>` — the count on the visible line, the table behind it — for a PR comment or `$GITHUB_STEP_SUMMARY` |
| `--detail-file <path>` | the full trace, colour forced off, as a CI artifact |
| `--title <text>` | heading for the summary file, so two of them in one comment are told apart by more than their chips line |

Two of these are measurements rather than conveniences.

**`--append-only`** moves every event's position from its handler's mint to its
commit, which is the one change that makes a stale read impossible: the log can
be behind, never wrong. Running with and without it is how you tell which of
the six reds that change would actually close. Today: **33 pass / 6 violations**
mint-ordered, **39 pass / 0 violations** append-only.

**`--no-fence`** turns the fence off everywhere, asking whether anything relies
on it. It is a diagnostic, not a world — **read the violation count, not the
pass count**, because a scenario whose whole point is that the guard fired
asserts exactly that and fails by design when you disarm it
(`in-flight-before-decision-counted` is the one that does this today).
Measured: **6 → 8** violations mint-ordered, so it is load-bearing there;
**0 → 0** append-only, so it is dead weight once positions are assigned at
commit.

## In CI

[`.github/workflows/world-sim.yml`](../../.github/workflows/world-sim.yml)
plays the book on every pull request, once per world, and posts both summaries
as one sticky comment — four lines until you open something:

```
## Sim World

Simulated world deterministic testing for races. [Traces](…)

▸ 🟠 Mint-ordered log — 6 fail of 39 total
▸ 🟢 Append-only log — 0 fail of 39 total
```

**It never blocks a merge**: six scenarios are red on purpose, so a lane that
gated on them would be red on every PR and read as broken rather than as
informative. What it publishes is the pair of counts, and the thing to look at
is whether they still say 6 and 0.

That is also why `pnpm test` in this package is `--report-only` while `pnpm sim`
stays strict — a recursive `pnpm -r test` should not go red for the six, but
someone running the book deliberately wants the exit code.

## Reading the output

Events in the printed stream are referred to by **log position** — `#12` is the
twelfth event in the durable log, `@7` the resource created at position 7 — and
the trace prints in *commit* order, so the numbers count backwards exactly where
the log and the execution disagree. See
[`packages/world-sim/README.md`](../../packages/world-sim/README.md#reading-the-output).

## What the scenarios show

The first three run the **same workflow with the same input** and differ only in
when the approval hook is delivered — inside the `step_started` commit, inside
the `step_completed` commit, or inside the `hook_created` commit. Same result,
three different event logs. Diff them against each other; that difference is
what a real deployment leaves to chance.

Two of them ("writers: …") make the underlying claim explicit: the two step
bodies of a single delivery are separately steerable writers to one log, and
holding one does not freeze the other.

The rest cover the properties that make scenarios usable as tests: a hook
racing a deadline (both branches, on demand), a thirty-day sleep that costs
microseconds, a step that retries twice, cancellation landing mid-step, and a
hook that never arrives — which is reported as a stall naming the undelivered
token rather than hanging the run.

## Red scenarios

Some scenarios fail, on purpose and by construction, and `pnpm sim` exits
non-zero because of them. They are reproductions of corruptions the runtime can
still produce: each states the outcome the run should have reached — the branch
its own durable log implies — and fails until the runtime gets there. The
failure line names both sides, e.g. `expected "afterSlow:doc-26", got
"afterFast:doc-26"`.

So a red is an open bug, not a recorded observation, and it goes green when the
bug is fixed rather than when the bug is seen once more. Which means the count
is the thing to watch, in either direction: one more is a regression, one fewer
means a scenario is ready to retire.

Run the book to see the current set — this file deliberately does not keep a
list, because a list here is a second copy of something the book already says
exactly, and it is the copy that goes stale. The analysis that is *not*
re-derivable from a run — which guard closes which shape, which of those guards
is armed in production and which is dark — is in
[`DESIGN.md`](../../packages/world-sim/DESIGN.md#the-six).

## Requirements

`run.ts` and the scenario book are TypeScript executed directly by Node's type
stripping, which needs Node >= 22.18 (the version pinned in `.node-version`).
Every workflow under test is compiled by the normal SDK build pipeline, exactly
as a deployment would compile it.
