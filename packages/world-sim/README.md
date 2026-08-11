# `@workflow/world-sim`

A deterministic, fully in-memory World for **playing out workflow scenarios**
and **checking that the world contract holds**.

It exists to answer questions that a real World cannot be asked, because in a
real World they are races:

> What happens if the approval webhook arrives *after* `step_started` is
> durable but *before* the workflow gets control back?

In `@workflow/world-local` you would answer that by polling in a loop and
hoping. Here you state it, and it is what happens — every time, byte for byte.

```ts
const wf = sim.writer.orchestrator();
await wf.runToEventCommitted('step_started', 'reserveInventory');
await sim.deliverHook('approval:doc-1', { approved: true });
await wf.release();
```

The resulting event stream:

```
  0     +0ms  wf                run_created       approvalWorkflow input=<17B>
  1     +0ms  wf                run_started
  2     +0ms  wf                hook_created     hook_…KX  token="approval:doc-1"
  3     +0ms  wf                step_created     step_…KY  reserveInventory input=<58B>
  4     +0ms  wf                step_started     step_…KY  reserveInventory
        +0ms  wf                >> held "orchestrator -> step_started step=reserveInventory (committed)" at events.create:after
  5     +0ms  ext                 hook_received    hook_…KX  token="approval:doc-1" payload=<44B>
  6     +0ms  reserveInventory  step_completed   step_…KY  reserveInventory result=<22B>
  …
```

The second column names the writer. The indented `hook_received` is written by
the scenario (`ext`) from *inside* the `events.create` call that committed
`step_started`, while the orchestrator is held in it. Advance a different
writer instead — `sim.writer.step('reserveInventory')` — and the same workflow,
same input and same output produce a different log, which is the point.

---

For how it is built — the interception model, the store's guards, the
determinism machinery, and the current test status — see [DESIGN.md](./DESIGN.md).

---

## The model

Three rules, and everything else follows from them.

**1. The World API is the schedule.** Every method is wrapped so a scenario can
run code `before` a call starts, or `after` its effect is committed but before
the awaiting caller is resumed. Since the World API is the only channel between
the runtime and the outside, that is a complete set of injection points.

**2. Nothing happens on its own.** `queue()` records a message and returns; it
never dispatches. The scheduler picks the next message — always the minimum by
`(readyAt, enqueueSeq)` — hands it to the flow handler, and waits for it to
finish before looking again. One delivery is in flight at a time.

**3. Time is a number the scheduler assigns.** `sleep('30d')` becomes a queue
message dated 30 days out; delivering it means moving the clock, not waiting.
`Date.now()` and `new Date()` read the virtual clock while a scenario runs
(timers are left alone — the runtime uses zero-delay macrotasks as ordering
barriers, and faking those would change the interleavings we came to observe).

Consequence: **scenarios terminate**. A month-long sleep costs microseconds. A
hook nobody delivers drains the queue and is reported as a *stall*, naming the
token that was never sent, instead of hanging. Delivery count, virtual span and
wall time are all capped as a backstop.

## Consistency checking

Every scenario ends with the event log re-read and the entity state
re-derived from it. `checkInvariants` verifies, among others:

| Rule | What it means |
| --- | --- |
| `log.monotonic-order` | Append order equals `(createdAt, eventId)` sort order — replay sees what happened |
| `run.created-first`, `run.created-once`, `run.terminal-is-last` | Run lifecycle shape (a step already running may still close out after termination) |
| `step.no-restart-after-terminal`, `step.terminal-once` | A finished step stays finished |
| `step.entity-matches-log`, `step.attempt-matches-log`, `run.entity-matches-log` | Materialized rows are a pure fold of the log |
| `hook.token-unique`, `hook.no-receive-after-dispose` | One live hook per token; disposal is final |
| `wait.resume-at-stable`, `wait.completed-once` | A wait's deadline is not rewritten (the sleep consumer treats a change as replay divergence) |

### Replay verification

Shape checks say the log is well formed. They do not say the log is *enough* —
that a fresh process handed it would rebuild the same run. That is the property
durability actually rests on, so every scenario that reaches `completed` or
`failed` ends with a cold start:

1. Take the committed log and withhold its terminal `run_*` event.
2. Seed the rest into an empty world as durable history.
3. Deliver one queue message to the same `workflowEntrypoint` a deployment
   serves, with the clock pinned to the instant the run ended.
4. The runtime must replay from the log alone and re-derive the event that was
   withheld, with the same output.

No step body re-executes — every `step_completed` is in the log, so the step
consumer resolves from it — which means anything the replay produces came from
the log and nothing else. Failures are named:

| Rule | What happened |
| --- | --- |
| `replay.diverged` | The runtime could not follow its own history: `REPLAY_DIVERGENCE` / `CORRUPTED_EVENT_LOG` |
| `replay.suspended` | The replay ran out of log before the workflow finished |
| `replay.output-differs`, `replay.status-differs` | It finished, with a different answer |
| `replay.log-differs` | It re-derived a different tail than the one withheld |

Skipped for `cancelled` and `stalled` runs: their terminal event came from an
operator, or never existed, so there is no workflow-derived answer to reproduce.

The store itself is a compact reference implementation of the same event →
entity state machine `@workflow/world-local` implements on the filesystem, with
all of that world's cross-process race machinery (claim files, per-entity
locks, staged hook events, canonical event-id pinning) removed — a scenario is
single-threaded, so those races cannot occur. Every *validation* is kept,
because rejections are the observable contract the runtime is written against.

## Two logs

The simulation can play against either of two logs, and the difference is one
question: **when does an event take its position?**

**Mint-ordered (the default) is what production does.** DynamoDB does not
generate ids, so workflow-server mints the event id at the handler boundary,
before the storage write is attempted — and that id *is* the log's sort key. A
write held between its mint and its commit therefore lands *behind* events that
were minted later and committed sooner. The log gains a row in the past, and
every read that happened in between saw a log the log itself went on to
contradict. That one fact is what the six red scenarios are about.

**Append-only (`appendOnlyLog: true`, `pnpm sim --append-only`) assigns the
position at commit instead.** A write that was overtaken while it was held gives
up its reserved position and re-mints at the tail. Two consequences follow, and
they are the whole point:

- Log order is commit order. Nothing is inserted behind a row a reader has
  already seen, so no two reads can disagree about the past.
- Every read is a *prefix* of the final log. A read can be short — it may miss
  a write that has not committed yet — but never self-inconsistent. Staleness
  collapses into lag, and lag is what an optimistic-concurrency fence can see;
  a hole is what it cannot.

Uncontended writes are untouched: a mint that is still the newest position when
it commits keeps its id, so a scenario that never holds a write mid-flight
produces a byte-identical log either way. `withholdNextEvent` follows the same
rule — it punches a hole in the default log and truncates the tail under
append-only, which is why `StaleRead` reports `{ eventId, hidden, truncated }`
and the trace says "lagging read" rather than "stale read".

The flag is a measurement, not a mode to develop in. The book scores **33 pass /
6 violations** mint-ordered and **39 / 0** append-only, and that difference is
the claim: all six reproduce a fault that only exists because position is
assigned before visibility.

The second measurement is the fence. `preconditionGuard` rejects a write whose
snapshot predates an out-of-band event; forcing it off across the book
(`--no-fence`) asks whether anything relies on it. Violations go **6 → 8**
mint-ordered — so it is load-bearing there — and **0 → 0** append-only, so it is
dead weight once positions are assigned at commit. Read the violation count and
not the pass count: a scenario whose point is that the guard fired asserts
exactly that, and fails by design when you disarm it.

## Usage

```ts
import { loadFlowHandler, renderScenario, runScenario } from '@workflow/world-sim';
// Separate entry on purpose: this one reaches SWC and esbuild through
// `@workflow/builders`, and playing a scenario should not drag a compiler into
// the module graph.
import { buildSimBundle } from '@workflow/world-sim/build';

// The orchestrator runs from a code string inside a VM, so a scenario needs
// the same compiled bundle a deployment would serve.
const bundle = await buildSimBundle({ cwd: process.cwd(), dirs: ['workflows'] });
const handler = await loadFlowHandler(bundle.flowBundlePath);

const result = await runScenario(
  {
    // The stable handle: what a bug report cites and `pnpm sim <id>` selects.
    // The prose `name` next to it is free to be reworded.
    id: 'hook-at-step-started',
    name: 'hook arrives inside the step_started commit',
    // Named from the build manifest — no client transform needed.
    workflow: 'approvalWorkflow',
    input: ['doc-1'],
    script: async (sim) => {
      const wf = sim.writer.orchestrator();
      await wf.runToEventCommitted('step_started', 'reserveInventory');
      await sim.deliverHook('approval:doc-1', { approved: true });
      await wf.release();
    },
    expect: { status: 'completed' },
  },
  { handler, workflowIds: bundle.workflowIds }
);

console.log(renderScenario(result));
```

`workbench/sim-world` is a worked example: `pnpm sim` builds its workflows,
plays 39 scenarios, prints every event stream, and exits non-zero if any
expectation or invariant fails.

`expect` states what *correct* looks like, which is not always what happens
today. There is no way to expect a consistency violation: a scenario that
reproduces a corruption declares the outcome the run should have reached and
stays red until the runtime delivers it. Six of the 39 are red for that reason.
The alternative — letting a scenario pass because the bug it documents is still
present — makes a suite that is green and a system that is broken, and gives no
signal on the day someone fixes it.

## Reading the output

Events are referred to one way and one way only: **by log position**. `#12` is
the twelfth event in the durable log — the log sorted the way `events.list`
sorts it, `(createdAt, eventId)` — and `@7` is the resource created at position
7, in the column where a raw correlation ULID used to be. Ids in violation
messages are rewritten to positions on the way out, so a claim like "the hook is
at 7 and `wait_completed` at 8" is one a reader can check against the output
instead of translating first.

The trace prints in **commit** order and is numbered in **log** order. Those are
the same thing right up until they are not, so a run whose durable log
disagrees with the order its writers actually committed in shows up as positions
counting backwards:

```
# 8    +1.0m  wf   wait_completed   @6
# 7    +1.0m  ext    hook_received  @2   token="count:doc-29"
# 9    +1.0m  wf   step_created     @9   settle
```

That is the whole subject of the red scenarios, visible on one line: the hook
owns position 7, the timeout at 8 was committed first, and the branch at 9 went
with the timeout. Out-of-order positions are highlighted when colour is on.

Colour is applied only when stdout is a terminal, and is off under `NO_COLOR`
or `--no-color`; pass `{ color: true }` to force it. With colour off the output
is plain ASCII, stable enough to check in as a golden file.

## API reference

Three things a script works with. A **writer** is a thread of execution. An
**advance** moves one writer to a named place and holds it there. A
**withholding** hides something from readers without holding anyone.

### Writers

A run is not one program. Several writers append to one event log, and the log
is the only thing that makes them agree. Each one crosses the world boundary,
is assigned a position in the event log, and commits to storage.

| writer | handle | what it is | what it writes |
| --- | --- | --- | --- |
| `orchestrator` | `sim.writer.orchestrator()` | The workflow function and the runtime around it, committing at a suspension point. One per queue delivery. | the run lifecycle, `step_created` / `step_started`, `hook_created`, `wait_*` |
| `step:<name>` | `sim.writer.step('<name>')` | One step body, running inline with full Node access. Two steps sharing a function name share the writer. | its own `step_completed` / `step_failed` / `step_retrying`, and any `attr_set` from step context |
| `external` | none — see [Withholdings](#withholdings) | The scenario, acting as a webhook receiver or an operator | `hook_received`, `run_cancelled` |

Two step bodies in a *single* delivery are already two writers racing to the
same log: no second invocation and no real threads are required. That is why the
vocabulary is per-writer rather than per-invocation.

`sim.writer.anyStep()` and `sim.writer.any()` are handles that match more than
one writer — whichever reaches the advance first. A handle is a *name*, not a
live object, so `sim.writer.step('slow')` can be taken before that step exists.
`sim.writer.seen()` lists the ids observed so far, in first-appearance order.

### Advances

An advance tells one writer to move to a named place and hold there until
`release()`. Every other writer keeps running, so whatever the script does in
between is guaranteed to land first.

```ts
script: async (sim) => {
  const wf = sim.writer.orchestrator();
  const reserve = sim.writer.step('reserveInventory');

  // Hold just after step_started is committed and before the orchestrator is
  // resumed — the window the whole instrument exists for.
  await wf.runToEventCommitted('step_started', 'reserveInventory');
  sim.check('no payload yet', !sim.world.events().some((e) => e.eventType === 'hook_received'));
  await sim.deliverHook('approval:doc-1', { approved: true });

  // Arm the next wait BEFORE releasing: a released writer can reach the next
  // point within the same turn, and a wait armed afterwards has missed it.
  const done = reserve.runToEventCommitted('step_completed');
  await wf.release();
  await done;
  await reserve.release();
}
```

| method | writer | description |
| --- | --- | --- |
| `wf.runToEventProduced(type, opts?)` | any | Hold once the event has crossed the world boundary — formed, attributed, in the trace — and before it is assigned a position in the event log. Anything committed to storage during the hold sorts *ahead* of it. |
| `wf.runToPositionMinted(type, opts?)` | any | Hold once the event is assigned a position in the event log and before it is committed to storage. The position is fixed and no reader can see it, so anything committed during the hold sorts *behind* it. |
| `wf.runToEventCommitted(type, opts?)` | any | Hold once the event is committed to storage, before the writer resumes. |
| `wf.runToCall(call, opts?)` | any | The same three places, for a world call that is not `events.create`. `opts.phase` picks which, and defaults to after the call returns. |
| `wf.release()` | the held one | Let the writer go. Idempotent; awaiting it yields the event loop, so the writer has really moved by the time it resolves. |
| `wf.isHeld()` / `wf.history()` | — | Is it held / where it has been. |
| `sim.park(match, label?)` | whichever matches | Hold the next matching call, whoever makes it. |
| `sim.until(match, label?)` | whichever matches | Wait for a matching call, without holding it. |
| `sim.during(match, body)` | whichever matches | `park`, run `body` while it is held, then release. |

`type` is one event type or several. `opts` is a step name as a bare string, or
`{stepName, token, correlationId, where, label, timeoutMs}`.

**Not every world assigns a position without also committing it.** Under
`appendOnlyLog` a write overtaken while held gives up its position and re-takes
the tail when it commits, so what `runToPositionMinted` holds is provisional and
the gap it opens is closed by construction. See [Two logs](#two-logs).

`runTo` is **level-triggered**: it consults recorded history, so a point this
writer already passed is an `AlreadyPassedError` naming the point rather than a
wait that never ends. Asking twice means "the next one". Each advance carries a
watchdog (`limits.maxRunToWallMs`) whose timeout reports where *every* writer
was standing, which is a diagnosis rather than the scenario's global budget
running out.

Two mistakes are worth knowing, and the errors name both:

- **Arming too late.** Releasing writer A before arming writer B's wait. B's
  step body may already be in flight and commit during the release.
- **Naming the wrong writer.** `step_started` is the orchestrator's write;
  `step_completed` is the step body's. The wrong one is a timeout.

`park` / `until` / `during` take a raw match object and are what the writer
handles are built from. Fields are ANDed; `eventType` implies `events.create`,
`stepName` accepts the machine name or the plain function name, `where` covers
what the declarative fields cannot say, and `phase` defaults to `'after'`:

```ts
{ call: 'events.create' | 'queue' | 'runs.get' | … , phase: 'before' | 'after',
  eventType, stepName, correlationId, token, runId, writer, failed, where }
```

Reach for them when the point is a *state* rather than a name. `where` is the
one thing a level-triggered `runTo` cannot re-check against history, so a
`where` wait is edge-triggered and leans on its timeout.

The park/permit model — and the word *tempo* for the resulting order — is lifted
from [`blanket`](https://bernat.tech/posts/blanket-deterministic-threading/),
which does this for Python's `threading` primitives. The mapping is direct: a
world call is a transaction, the `after` phase is its parking state, and
`release()` is the permit.

A script is the only way to hang this simulator, because a held call blocks its
writer and in the limit the scheduler. Three guards close that: the per-advance
watchdog above, the runner reporting what a script was still waiting for instead
of awaiting it forever, and a wall-clock deadline that releases every held call
and rejects every pending wait. A script that throws is reported as a scenario
problem rather than a World error, so a broken script is never misread as a
runtime bug.

### Withholdings

A withholding hides something from readers without holding the writer that
produced it. An advance stops one thread; a withholding lets every thread run
and changes what storage answers.

| method | writer | description |
| --- | --- | --- |
| `sim.withholdNextEvent(reads?)` | whichever commits next | Hide the next event committed to storage from the next `reads` event-log reads (default 1). Call it immediately before the write to hide. |
| `sim.beginHookDelivery(token, payload)` | `external` | Deliver a hook, withheld between its two halves: assigned a position in the event log, not committed to storage. Returns `{eventId, commit()}`. |

`beginHookDelivery` is the one place inside an `external` writer a script can
reach, and it is a withholding rather than an advance because holding that
writer would be the wrong model: an out-of-band receiver is a separate process,
so nothing of the run's is blocked while its write is in flight. Holding an
inline write would stall the delivery that made it, and the reader with it.

Both change shape with the log. Under `appendOnlyLog` a withheld read is cut
short at the withheld event instead of missing it from the middle — the log can
be behind, never wrong — and an overtaken hook re-takes the tail on `commit()`.

### Everything else a script can do

| | |
| --- | --- |
| `deliverHook(token, payload)` | Runs the real `resumeHook()` — the same code an out-of-band webhook receiver would |
| `cancelRun(reason?)` | Cancel the run under test |
| `advanceTime(ms)` | Jump the virtual clock |
| `note(msg)` / `check(name, cond)` | Record a marker / an assertion in the trace; a false check fails the scenario |
| `world` | Read-only snapshot: runs, events, steps, hooks, waits, pending messages, rejected calls |
| `appendOnlyLog` | Which log this run is playing against — for *phrasing* a check, never for branching the tempo |

A scenario with no script at all is a control: the run plays out on the default
schedule, and the only question is whether the log it leaves reproduces it.

## Extending the simulator

Adding a *scenario* needs none of this — see
[`workbench/sim-world/README.md`](../../workbench/sim-world/README.md#adding-a-scenario).
This section is for changing the instrument itself.

The module map is [DESIGN.md §1](./DESIGN.md#1-module-map). Routed by what you
are trying to do:

| I want to… | Change | Read first |
| --- | --- | --- |
| let scripts stop at a point they can't name today | `world.ts` — the call-point wrapper, and `CallMatch` in `types.ts` | [§3 Interception](./DESIGN.md#3-interception) |
| add a phase to an existing call | `CallPhase` in `types.ts`, where `world.ts` parks on it, plus the writer op that names it | [§3 Three phases](./DESIGN.md#three-phases-because-a-write-is-not-atomic) |
| add a rule the log must satisfy | `invariants.ts`, plus the rule table above | [§8 Consistency checking](./DESIGN.md#8-consistency-checking) |
| add or change a writer kind | `writers.ts` for the handles, `world.ts` for attribution | [§3 Writer attribution](./DESIGN.md#writer-attribution-is-derived-not-instrumented) |
| add a fault injector | `store.ts` — next to `withholdNextEvent` and the guards | [§5 Fault injection](./DESIGN.md#fault-injection) |
| change what a read returns | `store.ts` `applyWithhold` | [§5 The store](./DESIGN.md#5-the-store) |
| change where an event lands | `store.ts` `positionAtCommit` / `mintEvent` | [Two logs](#two-logs) above |
| add a spec field | `ScenarioSpec` in `scenario.ts`, `RunScenarioOptions` beside it, then `run.ts` for the CLI flag | [§6 Spec](./DESIGN.md#spec) |
| change the replay check | `replay.ts` | [§8 Replay verification](./DESIGN.md#replay-verification) |
| change the output | `report.ts` — `renderScenario`, `renderSummary`, `renderMarkdownSummary` | [Reading the output](#reading-the-output) above |

Three things worth knowing before you start:

**A new world flag is tri-state at the runner.** `ScenarioSpec` carries the
scenario's own choice, `RunScenarioOptions` carries the run-wide override, and
`undefined` means "leave it to the spec" — which is not the same as `false`,
because a scenario that asked for the flag itself must keep it. `run.ts` maps
`--x` / `--no-x` onto that, and the resolved value is what reaches
`createSimWorld` and the summary's chips line.

**Anything a scenario can observe has to survive replay.** `verifyReplay`
re-plays the committed log in a fresh world built from the same options, so a
new fault injector or store rule that is not applied on the replay path will
turn every scenario that uses it red for the wrong reason.

**Tests come in two shapes.** `src/*.test.ts` are vitest units against the
pieces in isolation — `store.test.ts` is the one to copy for anything that
changes what the log looks like, and the append-only block there is written as
pairs asserting *opposite* outcomes in the two worlds, which is the cheapest way
to prove a flag is actually doing something. The scenario book is the
integration test; run it before and after and diff the counts.

## What this does *not* give you

Worth being explicit, because the guarantees are narrower than "deterministic":

- **Determinism is world-level.** Step bodies are ordinary Node code. A step
  that calls `Math.random()`, reads a file, or hits the network is as
  nondeterministic here as anywhere. Keep step bodies pure, or stub them.
- **Only one interleaving per scenario.** Deliveries are serialized, so genuine
  concurrency between two in-flight invocations is not explored — a scenario
  pins *one* schedule rather than searching the space of them. (`selectNext`
  overrides which queued message goes next when the default order isn't the one
  you want.) This is the same trade `blanket` makes and states plainly: it
  *reproduces* orderings you can describe, it does not *discover* ones you
  can't. Systematic exploration and fault injection on world calls are the
  obvious next step; the call points are already the right hooks for both.
- **The store is a reimplementation, not the real thing.** It models
  `world-local`'s semantics rather than delegating to them, so in principle it
  could agree with the runtime while a real world disagrees. The strongest
  available fix is conformance testing: make the storage layer pluggable, run
  the same scenario book against `world-local`, and diff the event streams.
  That is the highest-value thing not yet built here.
- **"Before the workflow resumes" is about the log, not the CPU.** The hook is
  committed before the intercepted call returns, so it is in the log before the
  runtime's next read of it. Whether the runtime *observes* it on the very next
  replay depends on runtime optimizations (inline deltas, turbo) that can skip a
  re-read — which is itself a thing worth watching, and visible in the trace.
- **One scenario at a time per process.** The virtual clock and the World are
  process-global singletons.
- **Not a deployable World.** It has no persistence and no concurrency; it is a
  test instrument, and is intentionally not listed in `worlds-manifest.json`.
