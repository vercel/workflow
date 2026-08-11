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
determinism machinery, and the test status — see [DESIGN.md](./DESIGN.md).

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

Shape checks say the log is well formed, not that it is *enough* to rebuild the
run, so every scenario reaching `completed` or `failed` ends with a cold start:

1. Take the committed log and withhold its terminal `run_*` event.
2. Seed the rest into an empty world as durable history.
3. Deliver one queue message to the same `workflowEntrypoint` a deployment
   serves, with the clock pinned to the instant the run ended.
4. The runtime must replay from the log alone and re-derive the event that was
   withheld, with the same output.

No step body re-executes: every `step_completed` is in the log, so anything the
replay produces came from the log and nothing else. Failures are named:

| Rule | What happened |
| --- | --- |
| `replay.diverged` | The runtime could not follow its own history: `REPLAY_DIVERGENCE` / `CORRUPTED_EVENT_LOG` |
| `replay.suspended` | The replay ran out of log before the workflow finished |
| `replay.output-differs`, `replay.status-differs` | It finished, with a different answer |
| `replay.log-differs` | It re-derived a different tail than the one withheld |

Skipped for `cancelled` and `stalled` runs: their terminal event came from an
operator, or never existed, so there is no workflow-derived answer to reproduce.

The store behind all of this is a compact reference implementation of the same
event → entity state machine `@workflow/world-local` runs on the filesystem. Its
cross-process race machinery (claim files, per-entity locks, staged hook events,
canonical event-id pinning) is dropped, since a scenario is single-threaded;
every *validation* is kept, because rejections are the observable contract.

## World behaviors

A scenario picks the world it plays in, and each behavior below changes a rule
the runtime is written against.

**Mint-ordered log** — the default. A position is assigned when the event's
handler mints its id, and the event is committed to storage separately. The id
*is* the log's sort key, so a write held between the two lands *behind* events
minted later and committed sooner: an event can arrive in the past, and a read
taken in between saw a log the log itself went on to contradict.

**Append-only log** (`appendOnlyLog: true`) — a position is assigned at commit.
A write overtaken while it was held gives up its position and re-takes the tail.
Two things follow:

- Log order is commit order. Nothing is inserted behind a row a reader has
  already seen, so no two reads can disagree about the past.
- Every read is a *prefix* of the log. A read can be short — missing a write
  that has not committed yet — but never self-inconsistent. Staleness collapses
  into lag, and lag is what an optimistic-concurrency fence can see; a hole is
  what it cannot.

Uncontended writes are untouched either way: a position that is still the newest
when it commits keeps its id, so a scenario that never holds a write mid-flight
produces a byte-identical log in both. `withholdNextEvent` follows the same
rule — a hole in the mint-ordered log, a truncated tail under append-only —
which is why `StaleRead` reports `{ eventId, hidden, truncated }` and the trace
distinguishes a lagging read from a stale one.

**Precondition fence** (`preconditionGuard: true`) — rejects a write whose
`stateUpdatedAt` snapshot is strictly older than the newest externally
originated event. It is a high-water mark, so it sees a log truncated at the end
and is blind to a hole in the middle.

**Count guard** (`countGuard: true`) — adds the other half: how many events the
log holds at or below `stateUpdatedAt`, against how many the caller loaded. It
closes the hole a watermark cannot see, and requires the caller to send
`stateEventCount`. It is evaluated inside the fence's predicate, so it is only
live when the fence is.

Each is a spec field, and `RunScenarioOptions` carries a run-wide override —
`pnpm sim --append-only`, `--fence` / `--no-fence` — where `undefined` leaves
each scenario's own choice alone. Playing one book under two behaviors and
diffing the results is what the pair is for; [DESIGN.md
§5](./DESIGN.md#the-two-guards) has the guards in full.

## Usage

You write two things: a **workflow**, and a **script** that controls how that
workflow executes.

The workflow is ordinary workflow code, compiled the way a deployment compiles
it:

```ts
// workflows/index.ts
async function stepA(input: string) {
  'use step';
  return `a:${input}`;
}

async function stepB(input: string) {
  'use step';
  return `b:${input}`;
}

export async function twoStepsWorkflow(input: string) {
  'use workflow';
  const [a, b] = await Promise.all([stepA(input), stepB(input)]);
  return `${a}|${b}`;
}
```

Both steps are in flight at once, so which of them reaches the log first is a
race. The script decides it: hold `stepA` before its completion is assigned a
position, let `stepB` commit, then let both go.

```ts
const spec: ScenarioSpec = {
  // The stable handle: what a bug report cites and `pnpm sim <id>` selects.
  // The prose `name` beside it is free to be reworded.
  id: 'b-lands-first',
  name: 'stepB lands in the log before stepA',
  // Named from the build manifest — no client transform needed.
  workflow: 'twoStepsWorkflow',
  input: ['x'],
  script: async (sim) => {
    const a = sim.writer.step('stepA');
    const b = sim.writer.step('stepB');

    // Calling an advance starts watching for its point; awaiting it waits for
    // the writer to get there. Start both watches, then await both — asking
    // for a point that has already gone by is an error, not a wait.
    const watchA = a.runToEventProduced('step_completed');
    const watchB = b.runToEventCommitted('step_completed');
    await watchA;
    await watchB;

    await b.release();
    await a.release();
  },
  expect: { status: 'completed', output: 'a:x|b:x' },
};
```

`stepA` is held before it takes a position, so `stepB` gets the earlier one —
`#6 stepB`, `#7 stepA` — on every run, in either order the runtime would
otherwise have picked.

Playing it needs the compiled bundle, because the orchestrator runs from a code
string inside a VM:

```ts
import { loadFlowHandler, renderScenario, runScenario } from '@workflow/world-sim';
// Separate entry on purpose: this one reaches SWC and esbuild through
// `@workflow/builders`, and playing a scenario should not drag a compiler into
// the module graph.
import { buildSimBundle } from '@workflow/world-sim/build';

const bundle = await buildSimBundle({ cwd: process.cwd(), dirs: ['workflows'] });
const handler = await loadFlowHandler(bundle.flowBundlePath);

const result = await runScenario(spec, {
  handler,
  workflowIds: bundle.workflowIds,
});
console.log(renderScenario(result));
```

`expect` states what *correct* looks like, which is not always what the runtime
does. There is deliberately no way to expect a consistency violation: a scenario
reproducing a corruption declares the outcome the run should have reached and
stays red until the runtime delivers it, because a suite that goes green by
recording the bug gives no signal on the day someone fixes it.

[`workbench/sim-world`](../../workbench/sim-world/README.md) is the worked
example — a book of scenarios, a CLI that plays them, and a guide to adding
one.

## Reading the output

Events are referred to one way and one way only: **by log position**, so a claim
about the output is one a reader can check against it.

`#12` is the twelfth event in the log sorted the way `events.list` sorts it,
`(createdAt, eventId)`; `@7` is the resource created at position 7. Ids in
violation messages are rewritten to positions on the way out.

The trace prints in **commit** order and is numbered in **log** order, so a run
whose log disagrees with the order its writers committed in shows up as
positions counting backwards:

```
# 8    +1.0m  wf   wait_completed   @6
# 7    +1.0m  ext    hook_received  @2   token="count:doc-29"
# 9    +1.0m  wf   step_created     @9   settle
```

The hook owns position 7, the timeout at 8 was committed first, and the branch
at 9 went with the timeout. Out-of-order positions are highlighted when colour
is on.

Colour is applied only when stdout is a terminal, and is off under `NO_COLOR`
or `--no-color`; pass `{ color: true }` to force it. With colour off the output
is plain ASCII, stable enough to check in as a golden file.

## API reference

Three things a script works with. A **writer** is a thread of execution. An
**advance** moves one writer to a named place and holds it there. A
**withholding** hides something from readers without holding anyone.

### Writers

A run is not one program: several writers append to one event log, and each
write crosses the world boundary, is assigned a position in the event log, and
is committed to storage.

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

**Calling an advance starts watching; awaiting it waits for the hold.** The two
are separate on purpose: `const p = wf.runToEventCommitted(…)` is already
watching for that point, and `await p` only blocks the script until the writer
gets there. So a script that needs two writers held at once starts both
watches, then awaits both.

```ts
script: async (sim) => {
  const wf = sim.writer.orchestrator();
  const reserve = sim.writer.step('reserveInventory');

  // Hold just after step_started is committed and before the orchestrator is
  // resumed — the window the whole instrument exists for.
  await wf.runToEventCommitted('step_started', 'reserveInventory');
  sim.check('no payload yet', !sim.world.events().some((e) => e.eventType === 'hook_received'));
  await sim.deliverHook('approval:doc-1', { approved: true });

  // Start the next watch BEFORE releasing: a released writer can reach the
  // next point within the same turn, and a watch started afterwards has
  // missed it.
  const done = reserve.runToEventCommitted('step_completed');
  await wf.release();
  await done;
  await reserve.release();
}
```

| method | writer | description |
| --- | --- | --- |
| `wf.runToEventProduced(type, opts?)` | any | Hold once the event has crossed the world boundary — formed, attributed, in the trace — and before it is assigned a position in the event log. Anything committed to storage during the hold sorts *ahead* of it. |
| `wf.runToEventCommitted(type, opts?)` | any | Hold once the event is committed to storage, before the writer resumes. |
| `wf.release()` | the held one | Let the writer go. Idempotent; awaiting it yields the event loop, so the writer has really moved by the time it resolves. |
| `wf.isHeld()` / `wf.history()` | — | Is it held / where it has been. |
| `sim.park(match, label?)` | whichever matches | Hold the next matching call, whoever makes it. |
| `sim.until(match, label?)` | whichever matches | Wait for a matching call, without holding it. |
| `sim.during(match, body)` | whichever matches | `park`, run `body` while it is held, then release. |

`type` is one event type or several. `opts` is a step name as a bare string, or
`{stepName, token, correlationId, where, label, timeoutMs}`.

Both advances hold a writer whose event has no position yet, so a write that
commits during the hold sorts *ahead* of it. For the other order — an event that
already owns an earlier slot and has not appeared — hold the write itself with
[`sim.beginHookDelivery`](#withholdings), which reserves the position and hands
back a `commit()`. Under `appendOnlyLog` that reservation is provisional: an
overtaken write gives it up and re-takes the tail, which is exactly how the world
closes the gap. See [World behaviors](#world-behaviors).

`runTo` is **level-triggered**: it consults recorded history, so a point this
writer already passed is an `AlreadyPassedError` naming the point rather than a
wait that never ends. Asking twice means "the next one". Each advance carries a
watchdog (`limits.maxRunToWallMs`) whose timeout reports where *every* writer
was standing, which is a diagnosis rather than the scenario's global budget
running out.

Two mistakes are worth knowing, and the errors name both:

- **Watching too late.** Releasing writer A before B's watch has started. B's
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
| `deliverQueued(select?)` | Deliver one queued message now, concurrently with a held writer |
| `note(msg)` / `check(name, cond)` | Record a marker / an assertion in the trace; a false check fails the scenario |
| `world` | Read-only snapshot: runs, events, steps, hooks, waits, pending messages, rejected calls |
| `appendOnlyLog` | Which log this run is playing against — for *phrasing* a check, never for branching the tempo |

A scenario with no script at all is a control: the run plays out on the default
schedule, and the only question is whether the log it leaves reproduces it.

#### `deliverQueued`, and why it is not an advance

The scheduler is strictly serial: one message at a time, and the clock only
moves when it picks the next one up. So a held writer freezes virtual time
along with everything else, and a whole family of interleavings is simply
unreachable from the advances above — anything of the form *a timer fires while
a step result is outstanding*. Both halves need to be in flight at once, and the
loop will only ever have one.

`deliverQueued` takes a message out of the pending set and delivers it right
there in the script, so it runs alongside the held writer rather than after it.
`takeById` removes it first, so the loop can never pick up the same message: the
two are different deliveries running concurrently, not a race for one.

That concurrency is real, and so is its fallout. Two flow deliveries for one run
will collide the way they do in production — expect `EntityConflictError` and
`HookNotFoundError` in the rejection list once both branches finish. Those are
the deliveries losing races they are supposed to lose, not violations.

The default picks `pending[0]`, matching the loop's own order. Usually you want
to choose: a hook delivery enqueues a flow message of its own and it sorts
earlier than the timer you are almost certainly after.

```ts
const fired = sim.deliverQueued(
  (pending) => pending.find((m) => m.readyAtMs > sim.world.nowMs())?.messageId
);
```

Note the missing `await` — awaiting it here would wait for the delivery to
*finish*, which defeats the purpose. Arm a hold on the writer that delivery will
wake, fire it, await the hold, and the two are now interleaved. Await the
returned promise at the end to assert it found something.

## Extending the simulator

Changing the instrument itself, routed by task — adding a *scenario* needs none
of it, and is
[`workbench/sim-world/README.md`](../../workbench/sim-world/README.md#adding-a-scenario).
The module map is [DESIGN.md §1](./DESIGN.md#1-module-map).

| I want to… | Change | Read first |
| --- | --- | --- |
| let scripts hold at a point the API can't name | `world.ts` — the call-point wrapper, and `CallMatch` in `types.ts` | [§3 Interception](./DESIGN.md#3-interception) |
| add a phase to an existing call | `CallPhase` in `types.ts`, where `world.ts` parks on it, plus the writer op that names it | [§3 Two phases](./DESIGN.md#two-phases-and-a-third-hold-that-is-not-one) |
| add a rule the log must satisfy | `invariants.ts`, plus the rule table above | [§8 Consistency checking](./DESIGN.md#8-consistency-checking) |
| add or change a writer kind | `writers.ts` for the handles, `world.ts` for attribution | [§3 Writer attribution](./DESIGN.md#writer-attribution-is-derived-not-instrumented) |
| add a fault injector | `store.ts` — next to `withholdNextEvent` and the guards | [§5 Fault injection](./DESIGN.md#fault-injection) |
| change what a read returns | `store.ts` `applyWithhold` | [§5 The store](./DESIGN.md#5-the-store) |
| change where an event lands | `store.ts` `positionAtCommit` / `mintEvent` | [World behaviors](#world-behaviors) above |
| add a spec field | `ScenarioSpec` in `scenario.ts`, `RunScenarioOptions` beside it, then `run.ts` for the CLI flag | [§6 Spec](./DESIGN.md#spec) |
| change the replay check | `replay.ts` | [§8 Replay verification](./DESIGN.md#replay-verification) |
| change the output | `report.ts` — `renderScenario`, `renderSummary`, `renderMarkdownSummary` | [Reading the output](#reading-the-output) above |

Four things worth knowing before you start:

**The package entry is the scenario surface, not the whole package.**
`index.ts` exports what it takes to write a scenario, play it and render the
result. The construction kit — `createSimWorld`, `createSimStore`, `driveQueue`,
`verifyReplay`, `checkInvariants`, the clock — is imported from its own module,
so adding an option to one of them is not a change to the package's public
signature. Promote a name to the entry when something outside the package needs
it, not before.

**A new world flag is tri-state at the runner.** `ScenarioSpec` carries the
scenario's own choice, `RunScenarioOptions` the run-wide override, and
`undefined` means "leave it to the spec" — not the same as `false`, because a
scenario that asked for the flag must keep it. `run.ts` maps `--x` / `--no-x`
onto that, and the resolved value reaches `createSimWorld` and the chips line.

**Anything a scenario can observe has to survive replay.** `verifyReplay`
re-plays the log in a fresh world built from the same options, so a store rule
that is not applied there turns every scenario using it red for the wrong
reason.

**Tests come in two shapes.** `src/*.test.ts` are vitest units against the
pieces in isolation — copy `store.test.ts` for anything that changes what the
log looks like, where the append-only block is written as pairs asserting
*opposite* outcomes in the two worlds. The scenario book is the integration
test; run it before and after and diff the counts.

## What this does *not* give you

Worth being explicit, because the guarantees are narrower than "deterministic":

- **Determinism is world-level.** Step bodies are ordinary Node code. A step
  that calls `Math.random()`, reads a file, or hits the network is as
  nondeterministic here as anywhere. Keep step bodies pure, or stub them.
- **Only one interleaving per scenario.** Deliveries are serialized, so a
  scenario pins *one* schedule rather than searching the space of them
  (`selectNext` picks which queued message goes next). Same trade `blanket`
  makes: it *reproduces* orderings you can describe, it does not *discover*
  ones you can't.
- **The store is a reimplementation, not the real thing.** It models
  `world-local`'s semantics rather than delegating to them, so it could in
  principle agree with the runtime while a real world disagrees. The fix is
  conformance testing: make the storage layer pluggable, play the same book
  against `world-local`, and diff the event streams.
- **"Before the workflow resumes" is about the log, not the CPU.** The hook is
  committed before the intercepted call returns, so it is in the log before the
  runtime's next read of it. Whether the runtime *observes* it on the next
  replay depends on optimizations that can skip a re-read — visible in the
  trace.
- **One scenario at a time per process.** The virtual clock and the World are
  process-global singletons.
- **Not a deployable World.** It has no persistence and no concurrency; it is a
  test instrument, and is intentionally not listed in `worlds-manifest.json`.
