# world-sim: design

How `@workflow/world-sim` is built and why it is built that way. The package
README is the introduction; this is the implementation.

Two workspaces:

| path | what it is |
|---|---|
| `packages/world-sim` | the World implementation, the scenario runner, the checkers |
| `workbench/sim-world` | the scenario book and the workflows it runs (`pnpm sim`) |

---

## 1. Module map

| module | responsibility |
|---|---|
| `world.ts` | the `World` implementation; wraps every method as a call point and attributes it to a writer |
| `store.ts` | in-memory event store — the event → entity state machine, plus the write-time guards |
| `queue.ts` | deterministic queue: records messages, never delivers on its own |
| `clock.ts` | virtual clock; patches `Date.now()` readings, not timers |
| `ids.ts` | deterministic ULID minting from (virtual time, counter) |
| `drive.ts` | the scheduler loop and the scenario budgets |
| `tempo.ts` | the scripting layer: park / permit, and the wait bookkeeping under `runTo` |
| `writers.ts` | named writers and their level-triggered `runTo*` vocabulary |
| `scenario.ts` | runs one `ScenarioSpec` end to end and produces a `ScenarioResult` |
| `replay.ts` | cold-start replay verification of a finished log |
| `invariants.ts` | consistency checks re-derived from the event log alone |
| `report.ts` | renders a scenario as stable ASCII |
| `streams.ts` | in-memory streamer |
| `build.ts` | bundles a project's workflows so the runtime can be handed real compiled code |
| `types.ts` | the public vocabulary |

---

## 2. What the simulator has to model

The design follows from four properties of the runtime. None of them are
choices this package made; they are the constraints it works inside.

### The orchestrator is re-run from the top, every time

A workflow function is not a coroutine that parks and resumes. It is
re-executed from its first line on every replay pass, inside a fresh `node:vm`
context (`createContext` in `packages/core/src/vm/index.ts`). The VM seals the
two obvious sources of nondeterminism: `Math.random` is seeded from
`${runId}:${workflowName}:${deploymentId}`, and `Date.now()` / `new Date()`
return a fixed timestamp advanced only from each consumed event's `createdAt`.

A pass is therefore a pure function of (workflow code, run identity, event log
prefix). Stated precisely: **same log prefix → same decisions.** That is the
whole basis of durability, and it is also the property the simulator exists to
attack — the interesting bug class is not "the workflow behaved randomly" but
"the decisions and the persisted log disagree", which requires the decisions to
have been made against a *different* log than the one that ended up durable.

### Entity identity is positional

Correlation ids come from `ctx.generateUlid()`, driven by the VM's seeded
`Math.random`. They are positional ordinals of one seeded sequence: the Nth
entity the workflow asks for gets the same id in every pass. Steps, hooks and
waits all draw from that one sequence.

This is why a flipped branch is dangerous. It does not produce a different
step; it produces *a different step wearing the same name badge*. The runtime's
divergence check is a step-name comparison at the same ordinal:

```
Replay divergence: step event step_created for step_…445J belongs to
"…//settle", but the current step consumer is "…//recoverFirst"
```

### Suspension is the unit of progress

`useStep` does the same thing on every pass: mint the correlation id, register
a `StepInvocationQueueItem`, subscribe a consumer, return a promise. What
differs is what the consumer finds. On replay the log holds
`step_created` / `step_started` / `step_completed` for that correlation id, so
the consumer hydrates the recorded result and the step body is never called.
First time through, the consumer reaches the end of the log, returns
`NotConsumed`, and the promise never resolves — so the workflow cannot proceed.

When nothing can make further progress a `WorkflowSuspension` is raised
carrying the whole `invocationsQueue`. The runtime commits the pending
`*_created` events, executes what it can, and runs the workflow again from the
top against a longer log:

```
load log → run workflow from top → suspend → commit + execute → run from top → …
```

Hooks follow the same shape with a different event family. `hook_created` is
committed at the next suspension rather than at the call. An out-of-band
`resumeHook(token, payload)` writes `hook_received` **and enqueues a flow
message**, so the run wakes up. Payloads landing before the workflow awaits are
buffered in a `payloadsQueue`, which is why a duplicate delivery is absorbed
rather than lost.

There is no hook state a workflow can read — the surface is `token`,
`getConflict()`, `dispose()`, `then`, `[Symbol.asyncIterator]`. The only way to
observe a hook is to attach a continuation and see whether it resolves, which
is a *timing* observation, not a state read. That is why the scenario API
steers time rather than poking state.

### Nothing sleeps

`sleep()` registers a `WaitInvocationQueueItem`; `wait_created` records a
`resumeAt`; the runtime enqueues a delayed queue message. When that message is
delivered, the flow handler's "complete elapsed waits" pass compares
`Date.now() >= resumeAt` and writes `wait_completed`.

A timeout is a delayed message plus a clock comparison. That is exactly why
virtual time works here, and why a thirty-day sleep costs microseconds.

### Where the concurrency actually is

The workflow body is single-threaded JS and stays that way. The interleaving
that matters lives in three other places:

1. **Between passes.** The log grows. A branch decided in pass N was decided
   against pass N's prefix.
2. **Between event deliveries inside one pass.** Several awaits can be pending
   at once. The runtime forces resolution order to match log position via the
   delivery-barrier registry (`registerDeliveryBarrier` /
   `awaitEarlierDeliveries` in `private.ts`), so this one is reproducible.
3. **Between invocations.** Two flow deliveries for one run can execute
   simultaneously in different processes. This is the one the SDK cannot make
   deterministic by itself.

Two step bodies that suspend together are already concurrent writers to one
log, inside a single delivery. That is cheaper to reach than "concurrent
writers" suggests, and it is the case the writer vocabulary is built around.

---

## 3. Interception

### Every World method is a call point

Each method on the World is wrapped so a scenario can stop it. The wrapper
records the call, fires any matching watches, runs the underlying
implementation, fires the watches again on the way out, and only then resumes
the caller.

A watch action returns a promise, and the intercepted call awaits it. That is
the entire hold mechanism: a "held" writer is a caller blocked inside a World
method. `release()` resolves that promise.

### Three phases, because a write is not atomic

```ts
type CallPhase = 'before' | 'positioned' | 'after';
```

`before` and `after` bracket the call. `positioned` sits between them and
exists only for `events.create`, because a real backend mints the event id
*first* — DynamoDB does not generate ids, and that id is the log's sort key —
and only then attempts the storage write. Between the two, the event has a
position but no visibility.

That gap is the point, not a detail:

| held at | what a competing write does |
|---|---|
| `before` | no position taken yet, so a write landing during the hold sorts **ahead** |
| `positioned` | the slot is owned but invisible, so a competing write sorts **behind** |
| `after` | durable, and the writer has not been resumed yet |

`positioned` is the only way to produce an event *behind* a position a reader
has already read past — a complete, consistent log prefix that is simply
missing an event still in flight. No high-water-mark fence can represent that
shape. `after` is the window the package was originally built for: "the hook
arrives after `step_started` is durable and before the workflow resumes".

### Watches do not fire inside watches

Calls made from inside another watch's action are not call points. Without
that rule a watch on `events.create` would re-trigger on the `hook_received`
it just wrote, and every scenario using `deliverHook` would recurse forever.
The depth is tracked and surfaced in the trace, so a line committed from inside
a held call is visibly at depth > 0.

A related rule is easy to get wrong: the depth counter must be raised only by
`asExternal`, which brackets exactly one call. Raising it for the whole
duration of a watch *action* is correct for something that returns immediately
and wrong for a hold, which does not return until the scenario releases it —
under that rule, holding one writer makes every other writer's call stop being
a call point, so a held step body's sibling becomes invisible and unsteerable.

### Writer attribution is derived, not instrumented

Writer identity comes from the intercepted call plus its request. No runtime
hook is needed:

| write | writer |
|---|---|
| `step_created` / `hook_created` / `wait_created` / `run_*` / `attr_*` | orchestrator |
| `step_started` | orchestrator (the executor, which precedes the body) |
| `step_completed` / `step_failed` @ correlationId C | `step:<name of C>` |
| `hook_received` | external |
| `wait_completed` | the wait-continuation delivery |
| `events.list` / `runs.get` | orchestrator (the read half) |

The writer is printed as a column in every event stream, so a rendered log says
*who* wrote each line.

---

## 4. Determinism machinery

### Clock

`install()` patches `Date.now()` and the zero-argument `Date` constructor to
read the virtual clock. Timers are deliberately **not** patched:
`@workflow/core` uses `setTimeout(fn, 0)` as a macrotask barrier in several
ordering-sensitive places (`events-consumer.ts`, `private.ts`), and swapping
those for fake timers would change the very interleavings the simulation exists
to observe. Real zero-delay timers stay real; only the *readings* of wall time
move.

The clock never moves on its own. Only the scheduler calls `advanceTo` /
`advanceBy`, so two runs of a scenario see the same sequence of timestamps.

### Ids

Every id is a function of (virtual time, per-scenario counter) — never
`Math.random()` or the host clock. They still have to be real ULIDs, because
`@workflow/world` validates run ids with `z.string().ulid()` and decodes the
embedded timestamp, so the encoding is standard Crockford base32 with the
16 "random" characters filled from the counter.

Byte-identical ids run to run are what make an event-stream dump usable as a
golden file.

### Queue

`@workflow/world-local`'s queue fires a detached delivery loop from inside
`queue()`, so a message races whatever the caller does next. Faithful to
production, useless for a simulation.

Here `queue()` only *records*. Delivery happens when the scheduler asks, and it
always takes the same message: the minimum by `(readyAtMs, enqueueSeq)`. Delays
are virtual — a message 23 hours out is delivered by jumping the clock.
`ScenarioSpec.selectNext` can override the choice to pin an order the default
would not produce.

### Scheduler

```
take the next message → jump the clock to its delivery time → hand it to the
flow handler → wait → repeat until the queue is empty or a budget stops it
```

Between deliveries the loop drains the event loop for several rounds
(`settle()`), because the runtime uses zero-delay macrotasks as ordering
barriers and `waitUntil`-style background work is not awaited by anyone. Without
that drain, a message enqueued from a trailing microtask would be missed and the
scenario would report a spurious stall.

The scheduler lives apart from `scenario.ts` because two things drive it: a
scenario, and the replay verification that cold-starts a second world.

**One delivery at a time.** This is the deliberate limit of the model — see
§9.

---

## 5. The store

A reference implementation of the World storage contract: the same event →
entity state machine `@workflow/world-local` implements on the filesystem,
minus every mechanism that exists purely to make that state machine safe
against concurrent processes (exclusive-create claim files, per-entity locks,
staged/promoted hook events, canonical event-id pinning after a crash). One
delivery at a time in one process means those races cannot occur, and their
absence keeps the file small enough to audit.

What is deliberately kept is every validation that *rejects* an event —
terminal-run guards, step lifecycle ordering, hook token uniqueness, wait
duplication. Those rejections are the observable contract the runtime is
written against; a simulation that relaxed them would agree with the runtime
about nothing interesting.

### The two guards

Both are off by default and set per scenario (`ScenarioSpec.preconditionGuard` /
`.countGuard`, which flow into `SimWorldOptions`), which is how a scenario can
be run one flag apart from its neighbour.

**`preconditionGuard`** models `WorldCapabilities.preconditionGuard`: reject a
replay-context write whose `stateUpdatedAt` snapshot predates the newest
externally-originated event. In the SDK this is declared by **world-vercel
only** (`packages/world-vercel/src/index.ts:40`); `world-local` and
`world-postgres` declare neither it nor `maxConcurrency`.

Its predicate is narrower than the bug class, and the reason is its *shape*,
not the event type it watches. The marker advances on `hook_received` **or**
`step_completed`, but it is a **high-water mark** — the newest such write — and
the test is `stateUpdatedAt < marker`, strictly. So it detects a log truncated
at the end and is blind to a hole in the middle: when the withheld event is
*older* than one the reader can see, the reader's snapshot is never strictly
older than the mark. The hook direction is caught for the mirror-image reason —
the withheld `hook_received` is the newest out-of-band write and the
orchestrator's snapshot predates the sleep, so the fence fires and the run
reconciles.

**`countGuard`** adds the count half: how many events the log holds at or below
`stateUpdatedAt`, compared against how many the caller loaded. It closes the
hole the watermark cannot see, but it requires the caller to send
`stateEventCount`, which no client does today — so it is dark in production and
armed here only where a scenario asks for it.

### Fault injection

**`withholdNextEvent(reads = 1)`** hides the next committed event from the
following N event-log reads. This is the only way a serial simulation can
produce "a write derived from an incomplete event load", the precondition a
real deployment reaches through concurrency.

It is a faithful model rather than an approximation, because production reaches
the same ordering natively: `world-local` mints `evnt_${monotonicUlid()}` near
the top of `createImpl` (`packages/world-local/src/storage/events-storage.ts`)
and writes the file much later, so two concurrent creates take positions N and
N+1 and can land in the opposite order. Postgres does the same via `nextval`
before `COMMIT`. `world-local` defends this with `mintRunDominantEventKey`
(`src/storage/helpers.ts`) — but only for terminal run events;
`wait_completed` gets no re-derivation.

One withheld read poisons a whole invocation, which is worth knowing when
reading a trace: after the next `step_completed` the runtime continues from its
cursor, fetching only events written strictly *after* that position. A withheld
event sitting before the cursor can never re-enter that invocation's view.
Incremental reads make the hole permanent.

**`beginHookDelivery(token, payload)`** returns an `InFlightWrite` — a write
held at the `positioned` phase, with `eventId` already fixed and `commit()`
still pending. Unlike a held writer, nothing is blocked meanwhile, because the
receiver is a separate process from the run's invocation. Holding an *inline*
write instead would stall the delivery that made it, and thus the reader too,
which is why the out-of-band writer is the one that can express this shape.

---

## 6. The scenario surface

### Spec

```ts
interface ScenarioSpec {
  name: string;
  description?: string;
  workflow: string | { workflowId: string };  // plain fn name, resolved via the build manifest
  input?: unknown[];
  script?: ScenarioScript;      // omitted = a control: run on the default schedule
  selectNext?: SelectNext;      // override queue delivery order
  verifyReplay?: boolean;       // default on for runs reaching completed/failed
  expect?: { status?: ScenarioOutcome; output?: unknown };  // output: deep equality
  limits?: ScenarioLimits;
  preconditionGuard?: boolean;  // advertise + enforce the optimistic-concurrency fence
  countGuard?: boolean;         // also enforce its count half
}
```

`expect.status` accepts the non-run outcomes (`stalled`, `budget-exceeded`)
because "this workflow deadlocks when the hook never arrives" is a property
worth pinning down rather than an accident to tolerate.

There is deliberately **no way to expect a consistency violation.** A scenario
reproducing a corruption states the outcome the run *should* have had and fails
until the runtime delivers it. A red is an open bug, not a recorded
observation, and it goes green when the bug is fixed rather than when the bug is
seen once more.

### Scripting

`ScenarioApi` is the complete set of sanctioned external inputs — anything a
real deployment could do out-of-band has an entry, so the script is a complete
description of what happened:

`deliverHook` · `beginHookDelivery` · `cancelRun` · `advanceTime` ·
`withholdNextEvent` · `note` · `check` · `world` (read-only snapshot) · `runId`

`Tempo` adds the steering: `writer` handles, plus the raw `park` / `until` /
`during` primitives. The vocabulary is borrowed from Python's `blanket`, which
does the same for `threading` primitives — the call *parks*, the script issues
the *permit*, and the resulting order of permits is the *tempo*.

### Writers

`sim.writer.orchestrator()` / `.step(shortName)` / `.anyStep()` / `.any()`
return a `Writer`. A handle is a **name, not a live object**: it can be taken
before the step exists and binds to whichever writer shows up under it.

| method | phase | meaning |
|---|---|---|
| `runToEventProduced` | `before` | decided and submitted, nothing in the log |
| `runToPositionMinted` | `positioned` | slot owned, invisible |
| `runToEventCommitted` | `after` | durable, writer not yet resumed |
| `runToCall` | any | the same for a non-`events.create` call |
| `release` | — | let it go; idempotent |
| `isHeld` / `history` | — | inspection |

Two implementation details of `release()` matter to scenario authors. It is
guarded by a `done` flag so double release is a no-op. And it awaits a full
macrotask turn before resolving — without that, `await release()` returns while
the resumed call is still queued as a microtask, and a scenario reading the log
on the next line sees the state it was trying to leave.

### `runTo` is level-triggered

It consults the history of points the writer has already reached *before*
arming anything, and throws `AlreadyPassedError` naming the call it happened at
if the point has gone by.

The alternative — arm a watch and wait — is a hang. A held call blocks its
writer, and when that writer is the one the scheduler is inside, it blocks the
loop; so there is no quiescence to fall back on and no timer to eventually
fire. An edge-triggered wait on an edge that has passed is the one way to lose
this package's termination guarantee, so it is made impossible rather than
documented.

Three consequences:

- **Holds must be armed before they are needed.** To catch two writers at the
  same point, start both waits and *then* await them. Awaiting the first before
  starting the second yields the event loop, and the other writer may sail past.
- **`runTo` on an already-held writer releases it first**, and arms the new
  watch *before* releasing. That order is load-bearing: the released writer can
  reach the next point within the same turn — the `after` phase of the very
  call it was held in is the common case — and a watch armed afterwards would
  miss it. The same rule applies to authors sequencing two writers: arm B
  before releasing A.
- **A call is two records, so `seq` cannot order them.** The `before` and
  `after` phases of one call share a `seq`, so each recorded point carries its
  own `ordinal` and the level check compares against that.

A watermark tracks how far each writer has been advanced. Points at or before
it are "already consumed" and do not count as already-passed — asking twice for
`step_completed` means the *next* one, which is what the duplicate-delivery
scenarios need.

### What is not offered

Writers form a dependency graph — the orchestrator awaits its own step bodies —
so not every interleaving exists to be asked for, and an unsatisfiable `runTo`
can only be reported, not prevented. The runtime's await graph is not visible
from here, so true deadlock detection is out of reach; the substitute is a
per-`runTo` watchdog that reports where every writer was standing.

---

## 7. Termination

Every scenario terminates. Four budgets, layered so the most specific one
reports first:

| budget | default | catches |
|---|---|---|
| `maxRunToWallMs` | 5 s | one `runTo` that will never be satisfied |
| `maxDeliveries` | 200 | a run that keeps re-enqueueing itself |
| `maxVirtualMs` | 365 d | `while (true) { await sleep('1d') }` |
| `maxWallMs` | 60 s | a genuinely non-terminating step body |

`maxRunToWallMs` sits far below `maxWallMs` on purpose: it can name which
writer failed to reach which point and where the others were standing, and that
diagnosis is worth more than the generic "ran out of wall clock" the global
deadline can offer. It is clamped to `maxWallMs` so lowering the global budget
does not require remembering to lower this one.

The scenario's global deadline must **not** be `unref`'d. An unref'd timer does
not hold the event loop open, so a total deadlock — every writer held, scheduler
blocked inside a held call, script awaiting the impossible — empties the loop
and exits Node with a bare "unsettled top-level await" instead of firing the
watchdog, which is precisely the case the watchdog exists for. The `finally`
already clears it, so it cannot outlive a scenario.

Stream readers get the same treatment: a reader that parked on an unfinished
stream would deadlock the scenario, so readers park on a promise the *writer*
resolves and `abortOpenReaders()` releases any still parked at teardown —
turning a hang into a reported diagnostic.

Outcomes are `WorkflowRunStatus | 'stalled' | 'budget-exceeded' | 'error'`. A
hook that never arrives is reported as a **stall naming the undelivered token**,
not a hang.

---

## 8. Consistency checking

Two independent checkers run over every scenario.

### Invariants

The store enforces most rules at write time by rejecting bad events — but "the
store rejected it" and "the log is actually consistent" are different claims,
and only the second is worth trusting. So `invariants.ts` re-derives everything
from the event log alone and compares against the entity rows.

25 rules, grouped:

```
log.monotonic-order          log.unique-event-id
run.created-first            run.created-once           run.terminal-is-last
run.entity-matches-log       run.attributes-match-log   run.output-materialized
run.resources-released
step.created-once            step.started-after-created step.terminal-after-created
step.terminal-once           step.no-restart-after-terminal
step.entity-has-log          step.entity-matches-log    step.attempt-matches-log
hook.token-unique            hook.received-after-created
hook.dispose-once            hook.no-receive-after-dispose
wait.created-once            wait.completed-after-created
wait.completed-once          wait.resume-at-stable
```

A violation is a bug somewhere — in the runtime that produced the sequence, in
the store that accepted it, or in the scenario that injected something
impossible. Which one is a question for the reader; the checker's job is only
to notice.

### Replay verification

The invariants check the log's *shape*. None of that answers the question
durability actually rests on: if a fresh process picked up this log tomorrow,
would it reconstruct the same run?

The check is a **cold start with the answer withheld**. Take the finished log,
drop its terminal `run_*` event, load the rest into an empty world as durable
history, and deliver one queue message. The real runtime — the same
`workflowEntrypoint` a deployment serves — replays from the log and must
re-derive the event that was removed, with the same output. No step body
re-executes, since every `step_completed` is in the log and the step consumer
resolves from it, so anything the replay produces came from the log alone.

In this frame, **replay is the serializability check.** A pass is pure, so
re-running it over the committed log asks whether the schedule had a serial
equivalent. Six failure ids:

`replay.diverged` · `replay.suspended` · `replay.output-differs` ·
`replay.log-differs` · `replay.status-differs` · `replay.budget`

`replay.diverged` is the runtime raising `ReplayDivergenceError`, exhausting
its recovery replays, and failing the run with `CorruptedEventLogError`.
`replay.suspended` means the replay ran out of log before the workflow
finished — the log did not contain enough to rebuild the run.

---

## 9. Current status

Measured on branch `sim-world`.

**Unit tests** — 61 passing across 8 files (`pnpm --filter @workflow/world-sim test`).

**Scenarios** — `pnpm sim` in `workbench/sim-world`:

```
39 scenario(s): 33 passed, 6 failed, 6 consistency violation(s)
```

Replay verification across those 39: **31 `ok`, 6 `MISMATCH`, 2 `skipped`**
(skipped where the run did not reach a terminal status).

`run.ts` exits non-zero, and that is the intended steady state. The six
failures are reproductions of corruptions the runtime can still produce; each
states the outcome its own durable log implies and fails until the runtime gets
there, so the failure line names both sides (`expected "afterSlow:doc-26", got
"afterFast:doc-26"`).

**The number is the thing to watch: six today.** A seventh is a regression;
five means something got fixed and a scenario is ready to retire. This does
make the suite unusable as a plain CI gate without pinning the six as a
baseline — a deliberate tradeoff, since the point at this stage is to expose the
bugs rather than to be green.

### The six

The `fix` column names the specific change that closes the scenario. `shown
green by` is the stronger claim: a *passing* scenario that is this one with that
fix armed, same workflow and same tempo, one flag apart. Where it says "none
yet", the fix is identified by argument but nothing in the book proves it.

| scenario | mechanism | fix | shown green by |
|---|---|---|---|
| `corrupt: stale event load + step-count fork` (doc-23) | `withholdNextEvent(1)` + `deliverHook`; hook at position 7, `wait_completed` at 8, no-hook branch at 9 | `preconditionGuard` — the withheld `hook_received` is the newest out-of-band write and the orchestrator's snapshot predates the sleep, so the watermark fires | `corrupt: same shape, with the optimistic-concurrency fence armed` (doc-24) |
| `corrupt: stale event load with EQUAL step counts` (doc-25) | same fault on a fork whose branches emit one step each | `preconditionGuard`, for the same reason | none yet |
| `corrupt: two racing STEPS, no hook anywhere` (doc-26) | two of the run's own `step_completed` events, one delivery | `countGuard`. **Not** `preconditionGuard`: the withheld completion is a hole in the middle of the log, which moves no high-water mark (§5) | none yet |
| `corrupt: two racing STEPS, WITH the precondition fence on` (doc-27) | same, `preconditionGuard: true`, zero rejections | `countGuard`. This row *is* the proof that the watermark half does not fix doc-26 | none yet |
| `in-flight: A commits BEFORE the decision — count guard off` (doc-29) | `beginHookDelivery`, committed before the decision is written | `countGuard` | `in-flight: same tempo, count guard ON — the write is fenced` (doc-30) |
| `in-flight: A commits AFTER the decision — no guard can see it` (doc-31) | `beginHookDelivery`, committed after the decision | none in the SDK. Needs an append-tail fence — `assertSlotAboveTail`, `vercel/workflow-server#692` | — |

So: **two** of the six have their fix demonstrated by a paired green scenario,
**three** have a fix identified but unproven here, and **one** has no fix at all.
Writing the three missing pairs is the obvious next increment.

Note what the `fix` column does *not* mean. `countGuard` closing doc-29 is a
statement about the World implementation, not about production: it requires the
caller to send `stateEventCount`, which no client does today (§5). Four of the
six therefore have no fix that is actually armed anywhere real.

Four of the six are hook-driven and two deliberately are not — the pair proves
the corruption needs no out-of-band event type. All the pure hook-timing
scenarios pass: placing a hook precisely is what works. What fails is a hook
that is durable in the log but absent from the read the live pass decided on.

The last row is the only one with no fix in the SDK: the hole opens *after* the
write that should have fenced it, in the quiescent gap between deliveries where
the run makes no writes and so meets no checks. `assertSlotAboveTail` in
`vercel/workflow-server#692` is the append-tail fence for it.

---

## 10. Limits

**Concurrent invocations are out of reach.** The scheduler does
`await deliver(...)`, so two flow deliveries for one run cannot overlap.
Reaching that would need concurrent delivery with hold points to pin the
interleaving. The gap matters because it is a real production route:
`resumeHook` writes `hook_received` *and* enqueues a flow message, so two
deliveries end up in flight — one writing `wait_completed` and deciding
no-hook, one seeing the hook and deciding hook-branch — racing to create the
same ordinal, with every reader holding a perfectly consistent view. Just
different ones.

Two step bodies inside one delivery are genuinely concurrent and separately
steerable, which is enough to reach the interesting corruption without a second
invocation. That is why the limit has been acceptable so far.

**Also untested:** turbo / optimistic-inline-start, which skip replays and so
give a stale branch somewhere to hide; and the fence's same-millisecond
behaviour, where an equal `stateUpdatedAt` passes by design as anti-livelock.

**Not modelled at all:** the concurrency machinery `world-local` needs and this
store omits — claim files, per-entity locks, staged/promoted hook events,
canonical event-id pinning after a crash. Bugs in those are invisible here.

---

## 11. A caveat worth stating

A simulated world only produces trustworthy results while its model matches
reality. Every simplification in §5 and every limit in §10 is a place where a
green scenario could be green for the wrong reason. The mitigations are that the
store keeps every *rejection* the real one performs, that the runtime under test
is the real `workflowEntrypoint` running real compiled workflow code, and that
every scenario ends by replaying its own log through that same runtime — but
none of those is a proof, and a red here is worth more than a green.
