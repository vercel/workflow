# sim-world workbench

Worked examples for `@workflow/world-sim`: workflows written to make ordering
visible, and a book of scenarios that pin down exactly when external input
arrives.

```bash
pnpm sim                 # play every scenario, print every event stream
pnpm sim hook            # only scenarios whose name contains "hook"
pnpm sim --verbose       # include queue deliveries in the trace
```

Exits non-zero if any scenario misses an expectation or trips a consistency
check, so it doubles as the package's integration test.

How the simulator underneath works is documented in
[`packages/world-sim/DESIGN.md`](../../packages/world-sim/DESIGN.md).

## What the scenarios show

The first three run the **same workflow with the same input** and differ only in
when the approval hook is delivered — inside the `step_started` commit, inside
the `step_completed` commit, or inside the `hook_created` commit. Same result,
three different event logs. Diff them against each other; that difference is
what a real deployment leaves to chance.

Every scenario states its ordering as a sequence of **writer advances** — stop
the orchestrator, or one named step body, at a point in the world API; act while
it is stopped; let it go. Two of them ("writers: …") make the underlying claim
explicit: the two step bodies of a single delivery are separately steerable
writers to one log, and holding one does not freeze the other.

The rest cover the properties that make scenarios usable as tests: a hook
racing a deadline (both branches, on demand), a thirty-day sleep that costs
microseconds, a step that retries twice, cancellation landing mid-step, and a
hook that never arrives — which is reported as a stall naming the undelivered
token rather than hanging the run.

## The six red scenarios

Six scenarios fail, on purpose and by construction. `run.ts` exits non-zero.

They are reproductions of corruptions the runtime can still produce, and there
is deliberately no way for a scenario to *expect* a violation. Each one states
the outcome the run should have reached — the branch its own durable log
implies — and fails until the runtime gets there. The failure line names both
sides, e.g. `expected "afterSlow:doc-26", got "afterFast:doc-26"`. So a red is
an open bug rather than a recorded observation, and it turns green when the bug
is fixed rather than when the bug is seen once more.

The number is the thing to watch: **six today**. A seventh is a regression, and
five means something got fixed and a scenario is ready to retire.

They also record what was ruled out along the way. The corruption needs no
out-of-band event type — two racing step bodies in one delivery are enough. It
needs no stale read either, once ids are minted at the handler boundary. And
`preconditionGuard` fences the hook variant while missing the step-vs-step one,
which is the asymmetry the count guard exists to fix.

Of the six, five have known fixes: four predate the count guard, and doc-29 goes
green the moment a client sends `stateEventCount` (the neighbouring scenario is
that same tempo with the flag on). The sixth, doc-31, has none — both guards are
armed and neither can fire, because the hook lands in the quiescent gap between
deliveries where the run makes no writes and so meets no checks. Closing it
needs an append-tail fence — `assertSlotAboveTail`, proposed in
`vercel/workflow-server#692`.

## Requirements

`run.ts` and the scenario book are TypeScript executed directly by Node's type
stripping, which needs Node >= 22.18 (the version pinned in `.node-version`).
The workflows under `workflows/` are compiled by the normal SDK build pipeline,
exactly as a deployment would compile them.
