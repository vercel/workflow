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

This README is about **adding a scenario**. The API for writing a script,
including writers, advances, and withholdings, is in the
[API reference](../../packages/world-sim/README.md#api-reference); how the
simulator works and how to change it is the rest of
[`packages/world-sim/README.md`](../../packages/world-sim/README.md), and the
internals are [`DESIGN.md`](../../packages/world-sim/DESIGN.md).

## Adding a scenario

One scenario, one file in [`scenarios/`](./scenarios), named after its id.
Copy the neighboring file and change what differs. Each file contains the full
scenario workflow.

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
the `scenarios` array. Order is the only thing that file decides: least complex
first, and each pair of near-identical scenarios adjacent, so a reader meets a
distinction right after the thing it is a distinction from. Put yours next to
the one it is a variation of.

The id is stable and hyphenated; it is what a commit message or a bug report
cites and what the command-line filter matches first. The `name` beside it is
prose, and you can reword it.

Export the workflow named by `workflow` from
[`workflows/index.ts`](./workflows/index.ts). They all live in that one
file so readers can compare a scenario with the branch it steers. Prefer
reusing one; a new workflow is only worth it when the shape you need to steer
does not exist yet.

### The shape of a script

Every script is the same three steps: **hold a writer at a named point, act
while it is held, let it go.**

```ts
const wf = sim.writer.orchestrator();
await wf.runToEventCommitted('step_started', 'reserveInventory');
await sim.deliverHook('approval:doc-1', { approved: true });
await wf.release();
```

Because the writer is held *inside* the world call, everything the script does
in between lands in the log before that writer is resumed. That is the entire
point of the writer API: the interleaving is stated, not raced for.

Every advance and everything a script can do while one is held is in the
[API reference](../../packages/world-sim/README.md#api-reference). Four things
from it come up on the first scenario you write:

- **Name the right writer.** `step_started`, `wait_created`, `hook_created`, and
  the run's own decisions belong to `sim.writer.orchestrator()`. A step's
  `step_completed` / `step_failed` belongs to that step body:
  `sim.writer.step('reserveInventory')`, or `sim.writer.anyStep()` for whichever
  gets there first. Naming the wrong one is a wait that times out, so the
  failure is loud, but knowing the rule saves the trip.
- **Pick the right advance.** `runToEventCommitted` is what most scenarios want.
  Reach for `runToEventProduced` when the point is that a write committed during
  the hold sorts *ahead* of the held event, and for `sim.beginHookDelivery` when
  it has to sort *behind* one.
- **Calling an advance starts watching; awaiting it waits for the hold.** To
  hold two writers at once, call both, then await both.
- **`runTo` is level-triggered.** Asking for a point that has already gone by
  is an error, not a wait that never ends.
- **Start B's watch before releasing A.** A released writer can reach the next
  point within the same turn, and a watch started afterwards has missed it.

And one thing the advances cannot do at all: a held writer stops the scheduler,
so virtual time stops with it and no timer can fire while anything is held. If
the interleaving you need is *a timer firing while a step result is
outstanding*, no arrangement of holds will reach it. `sim.deliverQueued` is the
way out. It delivers a queued message from inside the script, concurrently with
the hold. See
[the API reference](../../packages/world-sim/README.md#deliverqueued-and-why-it-is-not-an-advance)
for the shape, and
[`unclaimed-payload-under-fork.ts`](./scenarios/unclaimed-payload-under-fork.ts)
for it in use.

### What to assert, and what not to

Two different instruments, for two different things:

- **`sim.check`** asserts a *sentence about the middle of the run*: "the live
  pass decided the fork without the hook". It is the only way to pin down a
  fact that exists at one instant and is gone by the end.
- **`expect`** asserts the run's outcome: `status`, and `output` when the
  output is the point.

The runner checks the invariant that **a run's log must replay back into that
run**, so expectations should describe durable outcomes rather than incidental
intermediate ordering.

There is deliberately no way to expect a violation. A scenario states the
outcome the run should have reached and stays red until the runtime gets there.

### Per-scenario world flags

`preconditionGuard` and `countGuard` on the spec control the guards for that
scenario. The command-line fence flags below override them for a whole run.

## Flags

| Flag | Effect |
| --- | --- |
| `--verbose` | Include queue deliveries in the trace |
| `--color` / `--no-color` | Force color on through a pipe or off. Default: on for a terminal, off otherwise, so `pnpm sim > out.txt` is already diffable |
| `--fence` / `--no-fence` | Force the optimistic-concurrency fence on or off for every scenario |
| `--report-only` | Print every failure, but exit 0 |
| `--summary-file <path>` | Create one collapsed `<details>` with the count on the visible line and the table behind it for a PR comment or `$GITHUB_STEP_SUMMARY` |
| `--detail-file <path>` | Write the full trace with color forced off as a CI artifact |
| `--title <text>` | Set the heading for the summary file |

**`--no-fence`** turns the fence off everywhere, asking whether anything relies
on it. It is a diagnostic. **Read the violation count, not the
pass count**, because a scenario whose whole point is that the guard fired
asserts exactly that and fails by design when you disarm it
(`in-flight-before-decision-counted` is the one that does this today).

## In CI

[`.github/workflows/world-sim.yml`](../../.github/workflows/world-sim.yml)
plays the book on every pull request and posts its summary as one sticky comment:

```text
## Sim World

Simulated world deterministic testing for races. [Traces](…)

▸ 🟢 world-sim scenario book — 0 fail of 41 total
```

**It never blocks a merge**: the simulation is an informational measurement, so
the published count is the thing to look at rather than the check mark.

That is also why `pnpm test` in this package is `--report-only` while `pnpm sim`
stays strict. A recursive `pnpm -r test` should not go red for the known reds,
but someone running the book deliberately wants the exit code.

## Reading the output

The printed stream identifies events by **log position**. `#12` is the
twelfth event in the durable log, and `@7` is the resource created at position 7. The
trace prints in commit order. See
[`packages/world-sim/README.md`](../../packages/world-sim/README.md#reading-the-output).

## What the scenarios show

The first three run the **same workflow with the same input** and differ only in
when the approval hook is delivered: inside the `step_started` commit, inside
the `step_completed` commit, or inside the `hook_created` commit. Same result,
three different event logs. Diff them against each other; that difference is
what a real deployment leaves to chance.

Two of them ("writers: …") make the underlying claim explicit: the two step
bodies of a single delivery are separately steerable writers to one log, and
holding one does not freeze the other.

The rest cover the properties that make scenarios usable as tests: a hook
racing a deadline (both branches, on demand), a thirty-day sleep that costs
microseconds, a step that retries twice, cancellation landing mid-step, and a
hook that never arrives, which the runner reports as a stall naming the undelivered
token rather than hanging the run.

## Red scenarios

Some scenarios fail, on purpose and by construction, and `pnpm sim` exits
non-zero because of them. They are reproductions of corruptions the runtime can
still produce. Each states the outcome the run should have reached (the branch
its own durable log implies) and fails until the runtime gets there. The
failure line names both sides, e.g. `expected "afterSlow:doc-26", got
"afterFast:doc-26"`.

So a red is an open bug, not a recorded observation, and it goes green when the
bug is fixed rather than when the bug is seen once more. Watch the count in
either direction: one more is a regression, while one fewer
means a scenario is ready to retire.

Run the book to see the current set. This file deliberately does not keep a
list, because a list here is a second copy of something the book already says
exactly, and it is the copy that goes stale. [`DESIGN.md`](../../packages/world-sim/DESIGN.md#the-six)
contains the analysis that you cannot derive from a run: which guard closes
which shape, which guards are armed in production, and which are dark.

## Requirements

`run.ts` and the scenario book are TypeScript executed directly by Node's type
stripping, which needs Node >= 22.18 (the version pinned in `.node-version`).
The normal SDK build pipeline compiles every workflow under test, exactly
as a deployment would compile it.
