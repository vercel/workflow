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

Four scenarios ("corrupt: …") are pinned **reproductions**: they expect
`replay.diverged`, so they pass while the corruption reproduces and fail if it
ever stops — which is the signal to retire them. They also record what was ruled
out along the way: the corruption needs no out-of-band event type (two racing
step bodies are enough), and `preconditionGuard` fences the hook variant but not
the step-vs-step one.

## Requirements

`run.ts` and the scenario book are TypeScript executed directly by Node's type
stripping, which needs Node >= 22.18 (the version pinned in `.node-version`).
The workflows under `workflows/` are compiled by the normal SDK build pipeline,
exactly as a deployment would compile them.
