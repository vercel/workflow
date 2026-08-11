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

This README is about **adding a scenario**. The API a script is written in —
writers, advances, withholdings — is the
[API reference](../../packages/world-sim/README.md#api-reference); how the
simulator works and how to change it is the rest of
[`packages/world-sim/README.md`](../../packages/world-sim/README.md), and the
internals are [`DESIGN.md`](../../packages/world-sim/DESIGN.md).

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

- **Name the right writer.** `step_started`, `wait_created`, `hook_created` and
  the run's own decisions belong to `sim.writer.orchestrator()`. A step's
  `step_completed` / `step_failed` belongs to that step body —
  `sim.writer.step('reserveInventory')`, or `sim.writer.anyStep()` for whichever
  gets there first. Naming the wrong one is a wait that times out, so the
  failure is loud, but knowing the rule saves the trip.
- **Pick the right advance.** `runToEventCommitted` is what most scenarios want.
  Reach for `runToEventProduced` or `runToPositionMinted` when the point is
  whether a write committed during the hold sorts ahead of the held event or
  behind it.
- **Calling an advance starts watching; awaiting it waits for the hold.** To
  hold two writers at once, call both, then await both.
- **`runTo` is level-triggered.** Asking for a point that has already gone by
  is an error, not a wait that never ends.
- **Start B's watch before releasing A.** A released writer can reach the next
  point within the same turn, and a watch started afterwards has missed it.

### What to assert, and what not to

Two different instruments, for two different things:

- **`sim.check`** asserts a *sentence about the middle of the run* — "the live
  pass decided the fork without the hook". It is the only way to pin down a
  fact that exists at one instant and is gone by the end.
- **`expect`** asserts the run's outcome: `status`, and `output` when the
  output is the point.

And one rule that matters more than either: **do not restate an expectation per
world.** A scenario is one sequence of advances; the only thing a flag like
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
