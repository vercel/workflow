# world-sim: design

`@workflow/world-sim` models runtime interleavings with a deterministic World,
scheduler, and scenario runner. Its implementation follows the constraints and
tradeoffs below; the package README provides an introduction.

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
| `store.ts` | in-memory event store: the event → entity state machine, plus the write-time guards |
| `queue.ts` | deterministic queue: records messages, never delivers on its own |
| `clock.ts` | virtual clock; patches `Date.now()` readings, not timers |
| `ids.ts` | deterministic ULID minting from (virtual time, counter) |
| `drive.ts` | the scheduler loop and the scenario budgets |
| `tempo.ts` | the scripting layer: park / permit, and the wait bookkeeping under `runTo` |
| `writers.ts` | named writers and their level-triggered `runTo*` vocabulary |
| `scenario.ts` | runs one `ScenarioSpec` end to end and produces a `ScenarioResult` |
| `replay.ts` | cold-start replay verification of a finished log |
| `invariants.ts` | consistency checks re-derived from the event log alone |
| `report.ts` | renders a scenario; log positions for every event reference, color only when the destination is a terminal |
| `streams.ts` | in-memory streamer |
| `build.ts` | bundles a project's workflows so the runtime can be handed real compiled code. Its own entry (`@workflow/world-sim/build`), because it reaches a compiler and playing a scenario should not |
| `load.ts` | loads a built bundle's flow handler, the half of the old `build.ts` that needs no compiler |
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
attack. The interesting bug class is not "the workflow behaved randomly" but
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

```text
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
`NotConsumed`, and the promise never resolves, so the workflow cannot proceed.

When nothing can make further progress a `WorkflowSuspension` is raised
carrying the whole `invocationsQueue`. The runtime commits the pending
`*_created` events, executes what it can, and runs the workflow again from the
top against a longer log:

```text
load log → run workflow from top → suspend → commit + execute → run from top → …
```

Hooks follow the same shape with a different event family. `hook_created` is
committed at the next suspension rather than at the call. An out-of-band
`resumeHook(token, payload)` writes `hook_received` **and enqueues a flow
message**, so the run wakes up. Payloads landing before the workflow awaits are
buffered in a `payloadsQueue`, which is why a duplicate delivery is absorbed
rather than lost.

There is no hook state a workflow can read. The surface is `token`,
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

### Two phases, and a third hold that is not one

```ts
type CallPhase = 'before' | 'after';
```

`before` and `after` bracket the call:

| held at | what a competing write does |
|---|---|
| `before` | no position taken yet, so a write landing during the hold sorts **ahead** |
| `after` | durable, and the writer has not been resumed yet |

`after` is the window the package was originally built for: "the hook arrives
after `step_started` is durable and before the workflow resumes".

Neither phase produces the opposite order, and a write is not atomic, so the
opposite order is reachable: a real backend mints the event ID *first*.
DynamoDB does not generate IDs, and that ID is the log's sort key. Only
then attempts the storage write. Between the two the event has a position but
no visibility, and a write that commits in that window sorts **behind** it.

That gap is the point, not a detail. It is the only way to produce an event
*behind* a position a reader has already read past: a complete, consistent log
prefix that is simply missing an event still in flight. No high-water-mark fence
can represent that shape.

It is not a phase, though, because the writer holding it is not blocked inside a
World method: the script owns the two halves explicitly, via `reservePosition` /
`withReservedPosition` under `sim.beginHookDelivery` (§Withholdings below). A
phase would have been a second way to say the same thing, and it went unused.

### Watches do not fire inside watches

Calls made from inside another watch's action are not call points. Without
that rule a watch on `events.create` would re-trigger on the `hook_received`
the action wrote, and every scenario using `deliverHook` would recurse forever.
The depth is tracked and surfaced in the trace, so a line committed from inside
a held call is visibly at depth > 0.

A related rule is error-prone: only `asExternal` may raise the depth counter.
It brackets exactly one call. Raising the counter for the whole
duration of a watch *action* is correct for something that returns immediately
and wrong for a hold, which does not return until the scenario releases it.
Under that rule, holding one writer makes every other writer's call stop being
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
those for fake timers would change the interleavings the simulation exists
to observe. Real zero-delay timers stay real; only the *readings* of wall time
move.

The clock never moves on its own. Only the scheduler calls `advanceTo` /
`advanceBy`, so two runs of a scenario see the same sequence of timestamps.

### IDs

Every ID is a function of (virtual time, per-scenario counter), never
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
are virtual. The scheduler delivers a message 23 hours out by jumping the clock.
`ScenarioSpec.selectNext` can override the choice to pin an order the default
would not produce.

A run's orchestrator deliveries go one at a time, as on a per-run topic with
`maxConcurrency: 1` (`orchestratorRunIdOf` in `@workflow/world` says which
messages count; step messages and health checks never do). `deliver` takes the
run's lease before handing the message to the handler and gives it back when the
handler responds; `takeNext` skips an orchestrator message whose run holds a
lease, and the loop waits for the lease (or a new message) when only such
messages are pending. Since the loop is serial, only a script-started delivery
(`deliverQueued`) can find the lease taken, and it waits too.
`expireLease` is the explicit overlap: it drops the held delivery's lease (and,
with `redeliver`, makes its message pending again), which is the production
case of a delivery stalled past its visibility timeout. What makes that overlap
safe is the store's in-band fence, so a scenario that expires a lease is a
scenario about the fence.

### Scheduler

```text
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

**One delivery at a time.** This is the deliberate limit of the model. See
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

The store deliberately keeps every validation that *rejects* an event:
terminal-run guards, step lifecycle ordering, hook token uniqueness, wait
duplication. Those rejections are the observable contract the runtime is
written against; a simulation that relaxed them would agree with the runtime
about nothing interesting.

### The in-band fence

The store implements the fence every World implements on a single-orchestrator
run (spec >= 9; `WorldCapabilities.inBandFence`), and it is always on:

- **Count.** Per run, the number of positions allocated to in-band writes
  (`seqInBand`), next to the run's position count (`seq`). `run_created` holds
  the first in-band position (`IN_BAND_SEQ_AT_RUN_CREATION`).
- **Snapshot.** `events.list` returns `snapshot: { seq, seqInBand }`, read
  before the page, on every page.
- **Fenced creates.** An in-band create (`inBand: true`) whose
  `expectedSeqInBand` differs from the count is refused with
  `InBandSupersededError` (412) before anything is written, so a refusal
  allocates nothing. One without an expected count is a 400. The check and the
  append run under one per-run lock, because `create` awaits between its own
  checks and its append.
- **Out-of-band creates** move `seq` and never `seqInBand`, and are never
  refused by the fence.

`src/in-band-fence.test.ts` runs the shared conformance suite
(`packages/world/src/test-support/in-band-fence-conformance.ts`) against the
store, so it refuses and counts exactly as world-local and world-postgres do.

The queue is the other half of the single-writer guarantee: it hands out one
orchestrator delivery per run at a time (§4 Queue). The fence is what makes an
overlap the queue cannot rule out safe, and a scenario forces one with
`sim.expireLease()`: the held delivery keeps running while a successor starts
alongside it, and whichever writes in-band second is refused. The book's
overlap scenarios (`step-vs-step-fork-fenced`, `fence-catches-benign-direction`,
`in-flight-before-decision`, `stale-read-step-count-fork-fenced`) assert exactly
that.

An earlier version of the store modeled an out-of-band precondition guard (a
watermark on the newest out-of-band write, plus a count of the events at or
below it) behind per-scenario flags. Single-orchestrator runs have no such
guard: an out-of-band write never supersedes the orchestrator, and a write
decided from a lagging read is corrected by its skipped-slot report rather than
refused. It was removed along with the facade's reconstruction of the client's
loaded set, which only that guard read.

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
(`src/storage/helpers.ts`), but only for terminal run events;
`wait_completed` gets no re-derivation.

One withheld read poisons a whole invocation, which is worth knowing when
reading a trace: after the next `step_completed` the runtime continues from its
cursor, fetching only events written strictly *after* that position. A withheld
event sitting before the cursor can never re-enter that invocation's view.
Incremental reads make the hole permanent.

**`beginHookDelivery(token, payload)`** returns an `InFlightWrite`, a write
held between mint and commit, with `eventId` already fixed and `commit()`
still pending. Unlike a held writer, nothing is blocked meanwhile, because the
receiver is a separate process from the run's invocation. Holding an *inline*
write instead would stall the delivery that made it, and thus the reader too,
which is why the out-of-band writer is the one that can express this shape.

### Changing the world instead of the runtime

**`appendOnlyLog`** is the one option that alters the store's contract rather
than its strictness. With it on, an event takes its position in `append` instead
of at the handler boundary: a write that is still the newest when it commits
keeps the id it was already handed out under, and one that was overtaken while
it was held re-mints and takes the tail.

That single move collapses both faults above into the same, weaker one. A hold
between mint and commit can no longer open a hole, because the held write is not
claiming a position while it waits because it has none until it lands.
`withholdNextEvent` degrades from serving a read *around* the withheld event to
stopping it *at* the event, because a hole is not expressible in a log whose
order is its commit order. Both leave the reader short rather than wrong, and
a short read is what a write's skipped-slot report corrects.

Off by default: the sim exists to model the world that exists, and production
mints at the boundary because DynamoDB does not generate ids. The value of the
switch is differential. Play the book both ways, and the diff separates "fails
because of the mint-before-commit window" from "fails for some other reason".
No scenario in the book sets it; it is meant to be driven from
`RunScenarioOptions` or `pnpm sim --append-only`.

---

## 6. The scenario surface

### Spec

```ts
interface ScenarioSpec {
  id: string;                   // stable hyphenated handle; what `pnpm sim <id>` selects
  name: string;                 // prose, expected to be reworded; the id is not
  description?: string;
  workflow: string | { workflowId: string };  // plain fn name, resolved via the build manifest
  input?: unknown[];
  script?: ScenarioScript;      // omitted = a control: run on the default schedule
  selectNext?: SelectNext;      // override queue delivery order
  verifyReplay?: boolean;       // default on for runs reaching completed/failed
  expect?: { status?: ScenarioOutcome; output?: unknown };  // output: deep equality
  limits?: ScenarioLimits;
  appendOnlyLog?: boolean;      // position at commit, not at mint; see §5
}
```

`RunScenarioOptions.appendOnlyLog` overrides the last of those for every
scenario in a run, which is how the whole book gets played both ways;
`undefined` there leaves each spec to decide. The mode a result was produced
under is recorded on `ScenarioResult.appendOnlyLog` rather than left to the
reader's memory.

`expect.status` accepts the non-run outcomes (`stalled`, `budget-exceeded`)
because "this workflow deadlocks when the hook never arrives" is a property
worth pinning down rather than an accident to tolerate.

There is deliberately **no way to expect a consistency violation.** A scenario
reproducing a corruption states the outcome the run *should* have had and fails
until the runtime delivers it. A red is an open bug, not a recorded
observation, and it goes green when the bug is fixed rather than when the bug is
seen once more.

### Scripting

`ScenarioApi` is the complete set of sanctioned external inputs. Anything a
real deployment could do out-of-band has an entry, so the script is a complete
description of what happened:

`deliverHook` · `beginHookDelivery` · `cancelRun` · `advanceTime` ·
`withholdNextEvent` · `note` · `check` · `world` (read-only snapshot) · `runId`

`Tempo` adds the steering: `writer` handles, plus the raw `park` / `until` /
`during` primitives. The vocabulary is borrowed from Python's `blanket`, which
does the same for `threading` primitives: the call *parks*, the script issues
the *permit*, and the resulting order of permits is the *tempo*.

### Writers

`sim.writer.orchestrator()` / `.step(shortName)` / `.anyStep()` / `.any()`
return a `Writer`. A handle is a **name, not a live object**: it can be taken
before the step exists and binds to whichever writer shows up under it.

| method | phase | meaning |
|---|---|---|
| `runToEventProduced` | `before` | decided and submitted, nothing in the log |
| `runToEventCommitted` | `after` | durable, writer not yet resumed |
| `release` | — | let it go; idempotent |
| `isHeld` / `history` | — | inspection |

Two implementation details of `release()` matter to scenario authors. It is
guarded by a `done` flag so double release is a no-op. And it awaits a full
macrotask turn before resolving. Otherwise, `await release()` returns while
the resumed call is still queued as a microtask, and a scenario reading the log
on the next line sees the state it was trying to leave.

### `runTo` is level-triggered

It consults the history of points the writer has already reached *before*
arming anything, and throws `AlreadyPassedError` naming the call it happened at
if the point has gone by.

The alternative, arming a watch and waiting, causes a hang. A held call blocks its
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
  reach the next point within the same turn. The `after` phase of the call it
  was held in is the common case, and a watch armed afterwards would
  miss it. The same rule applies to authors sequencing two writers: arm B
  before releasing A.
- **A call is two records, so `seq` cannot order them.** The `before` and
  `after` phases of one call share a `seq`, so each recorded point carries its
  own `ordinal` and the level check compares against that.

A watermark tracks how far each writer has been advanced. Points at or before
it are "already consumed" and do not count as already-passed. Asking twice for
`step_completed` means the *next* one, which is what the duplicate-delivery
scenarios need.

### What is not offered

Writers form a dependency graph because the orchestrator awaits its own step bodies,
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
not hold the event loop open. A total deadlock, with every writer held, the scheduler
blocked inside a held call, and the script awaiting the impossible, empties the loop
and exits Node with a bare "unsettled top-level await" instead of firing the
watchdog, which is precisely the case the watchdog exists for. The `finally`
already clears it, so it cannot outlive a scenario.

Stream readers get the same treatment: a reader that parked on an unfinished
stream would deadlock the scenario, so readers park on a promise the *writer*
resolves and `abortOpenReaders()` releases any still parked at teardown,
turning a hang into a reported diagnostic.

Outcomes are `WorkflowRunStatus | 'stalled' | 'budget-exceeded' | 'error'`. A
hook that never arrives is reported as a **stall naming the undelivered token**,
not a hang.

---

## 8. Consistency checking

Two independent checkers run over every scenario.

### Invariants

The store enforces most rules at write time by rejecting bad events, but "the
store rejected it" and "the log is actually consistent" are different claims,
and only the second is worth trusting. So `invariants.ts` re-derives everything
from the event log alone and compares against the entity rows.

25 rules, grouped:

```text
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

A violation indicates a bug in the runtime that produced the sequence, in
the store that accepted it, or in the scenario that injected something
impossible. Which one is a question for the reader; the checker's job is only
to notice.

### Replay verification

The invariants check the log's *shape*. None of that answers the question
durability actually rests on: if a fresh process picked up this log tomorrow,
would it reconstruct the same run?

The check is a **cold start with the answer withheld**. Take the finished log,
drop its terminal `run_*` event, load the rest into an empty world as durable
history, and deliver one queue message. The real runtime (the same
`workflowEntrypoint` a deployment serves) replays from the log and must
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
finished because the log did not contain enough to rebuild the run.

---

## 9. Current status

**Scenarios:** `node run.ts --report-only` in `workbench/sim-world` passes the
whole book (42 scenarios, 0 consistency violations at the time of writing; run
it for the current count).

**The in-flight and stale-read family.** `in-flight-before-decision` (doc-29),
`in-flight-before-decision-counted` (doc-30), `in-flight-after-decision`
(doc-31) and `stale-read-step-count-fork-fenced` (doc-24) used to be the book's
open reproductions, and the reds were measured against the out-of-band
precondition guard of §5's last paragraph. On single-orchestrator runs each now
asserts what the model guarantees for the same tempo:

| scenario | tempo | what it asserts |
|---|---|---|
| `in-flight-before-decision` (doc-29) | the orchestrator is held with its timeout produced, the hook commits, the lease expires and a successor takes over | the successor decides from the log with the hook; the predecessor's stale `wait_completed` is refused with `InBandSupersededError` and never lands |
| `in-flight-before-decision-counted` (doc-30) | the hook commits while the branch decision is produced, one delivery | the out-of-band hook supersedes nothing; the log records the timer first and the run settles |
| `in-flight-after-decision` (doc-31) | the hook commits while the run is suspended after its branch | nothing is refused; the hook takes the tail and the next delivery finishes on the branch the log records |
| `stale-read-step-count-fork-fenced` (doc-24) | as doc-29, with the hook withheld from the successor's first read | the successor's accepted write gets the hook back in its skipped-slot report and takes the hook branch; the predecessor is refused |

Those handles are `ScenarioSpec.id`, and they select: `pnpm sim
in-flight-after-decision` plays one row of this table.

The book is still a poor plain CI gate when it has reds, which is what
`--report-only` is for: it prints every failure and exits 0, so a job can
*publish* the book's current state rather than block on it. `--summary-file`
writes one collapsed `<details>` element with a visible line carrying the count
and a green or orange dot, and the whole table behind it, for a PR comment or
`$GITHUB_STEP_SUMMARY`. `--detail-file` writes the full color-free trace as an
artifact to read when a number moves. The workbench's `pnpm test` is
`--report-only --summary-file`, so a recursive `pnpm -r test` stays green and
still says what happened; `pnpm sim` stays strict, so running it by hand fails
loudly.

---

## 10. Limits

**Concurrent invocations are out of reach.** The scheduler does
`await deliver(...)`, so two flow deliveries for one run cannot overlap.
Reaching that would need concurrent delivery with hold points to pin the
interleaving. The gap matters because it is a real production route:
`resumeHook` writes `hook_received` *and* enqueues a flow message, so two
deliveries end up in flight. One writes `wait_completed` and decides
no-hook, while the other sees the hook and decides hook-branch. They race to create the
same ordinal, with every reader holding a perfectly consistent view. Just
different ones.

Two step bodies inside one delivery are genuinely concurrent and separately
steerable, which is enough to reach the interesting corruption without a second
invocation. That is why the limit has been acceptable so far.

**The lazy hook-resume path is never exercised.** `resumeHook` picks lazy vs
sequential from `world.capabilities.hookResumeDedup` (or a fresh server
attestation). `world-local` declares it and `world-vercel` attests it per
lookup, so **every real world takes the lazy path**, where the producer writes
no event and the consumer materializes `hook_received` from the queue message
through the durable `(runId, resumeId)` claim. The sim advertises neither the
capability nor a `resumeId` dedupe, so every sim hook delivery takes the
sequential path, meaning the hook-timing shapes in this book are the *legacy*
shape, not the one production runs. Closing this needs `(runId, resumeId)`
dedupe in the store plus the capability; it is the largest single gap for a
package about hook races.

**Also untested:** turbo / optimistic-inline-start, which skip replays and give
a stale branch somewhere to hide.

**Not modeled at all:** the concurrency machinery `world-local` needs and this
store omits, including claim files, per-entity locks, staged/promoted hook events,
canonical event-id pinning after a crash. Bugs in those are invisible here.

---

## 11. A caveat worth stating

A simulated world only produces trustworthy results while its model matches
reality. Every simplification in §5 and every limit in §10 is a place where a
green scenario could be green for the wrong reason. The mitigations are that the
store keeps every *rejection* the real one performs, that the runtime under test
is the real `workflowEntrypoint` running real compiled workflow code, and that
every scenario ends by replaying its own log through that same runtime, but
none of those is a proof, and a red here is worth more than a green.
